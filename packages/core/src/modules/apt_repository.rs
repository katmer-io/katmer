use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::{Context, Result};
use regex::Regex;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct AptRepositoryModule;

fn dq(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '_' {
            out.push('-');
        }
    }
    if out.is_empty() {
        out.push_str("katmer");
    }
    out
}

fn normalize_repos(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    } else if let Some(arr) = v.as_array() {
        for item in arr {
            if let Some(s) = item.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    out.push(t.to_string());
                }
            }
        }
    }
    out
}

#[async_trait::async_trait]
impl KatmerModule for AptRepositoryModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let check = ctx.exec("command -v apt-get >/dev/null 2>&1; echo $?", None).await?;
        if check.stdout.trim() != "0" {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "apt_repository: apt-get not found".to_string(),
                stdout: Some(check.stdout),
                stderr: Some(check.stderr),
            });
        }

        let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("present");
        let regexp = params.get("regexp").and_then(|v| v.as_str()).map(|s| s.to_string());
        let update_cache = params.get("update_cache").and_then(|v| v.as_bool()).unwrap_or(false);
        let check_mode = params.get("check_mode").and_then(|v| v.as_bool()).unwrap_or(false);

        if state == "present" && regexp.is_some() {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "apt_repository: 'regexp' is not supported with state: 'present'".to_string(),
                stdout: None,
                stderr: None,
            });
        }
        if regexp.is_some() && params.get("repo").is_some() {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "apt_repository: 'regexp' and 'repo' cannot be used together".to_string(),
                stdout: None,
                stderr: None,
            });
        }

        let filename = params.get("filename").and_then(|v| v.as_str()).map(|s| s.to_string());
        let repos = params.get("repo").map(normalize_repos).unwrap_or_default();

        if state == "present" {
            if repos.is_empty() {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: "apt_repository: 'repo' is required for state: 'present'".to_string(),
                    stdout: None,
                    stderr: None,
                });
            }
        } else if state != "absent" {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "apt_repository: state must be 'present' or 'absent'".to_string(),
                stdout: None,
                stderr: None,
            });
        }

        let mut base_name = if let Some(f) = filename {
            f
        } else if let Some(first) = repos.first() {
            slugify(first)
        } else {
            "katmer".to_string()
        };
        if !base_name.ends_with(".list") {
            base_name.push_str(".list");
        }
        let dest = format!("/etc/apt/sources.list.d/{}", base_name);

        let read = ctx.exec(&format!("cat {} 2>/dev/null || true", dq(&dest)), None).await?;
        let original = read.stdout.replace('\r', "");
        let mut lines: Vec<String> = original
            .split('\n')
            .map(|l| l.to_string())
            .filter(|l| !l.is_empty())
            .collect();

        let mut changed = false;

        if state == "present" {
            for repo in &repos {
                if !lines.iter().any(|l| l.trim() == repo.trim()) {
                    lines.push(repo.trim().to_string());
                    changed = true;
                }
            }
        } else {
            if let Some(re) = regexp {
                let rx = Regex::new(&re).context("apt_repository: invalid regexp")?;
                let before = lines.len();
                lines.retain(|l| !rx.is_match(l));
                changed = before != lines.len();
            } else if !repos.is_empty() {
                let before = lines.len();
                lines.retain(|l| !repos.iter().any(|r| r.trim() == l.trim()));
                changed = before != lines.len();
            }
        }

        if changed && !check_mode {
            if lines.is_empty() {
                let rm = ctx.exec(&format!("sudo rm -f -- {}", dq(&dest)), None).await?;
                if rm.code != 0 {
                    return Ok(ModuleResponse {
                        changed: false,
                        failed: true,
                        msg: "apt_repository: failed to remove sources file".to_string(),
                        stdout: Some(rm.stdout),
                        stderr: Some(rm.stderr),
                    });
                }
            } else {
                let mut body = lines.join("\n");
                body.push('\n');
                let tmp = format!("/tmp/katmer-apt-sources-{}.tmp", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis());
                let stage = format!("cat > {} <<'KATMER_EOF'\n{}KATMER_EOF", dq(&tmp), body);
                let r_stage = ctx.exec(&stage, None).await?;
                if r_stage.code != 0 {
                    let _ = ctx.exec(&format!("rm -f -- {}", dq(&tmp)), None).await;
                    return Ok(ModuleResponse {
                        changed: false,
                        failed: true,
                        msg: "apt_repository: failed to stage sources file".to_string(),
                        stdout: Some(r_stage.stdout),
                        stderr: Some(r_stage.stderr),
                    });
                }
                let install = ctx.exec(&format!("sudo mkdir -p -- /etc/apt/sources.list.d && sudo mv -f -- {} {}", dq(&tmp), dq(&dest)), None).await?;
                if install.code != 0 {
                    let _ = ctx.exec(&format!("rm -f -- {}", dq(&tmp)), None).await;
                    return Ok(ModuleResponse {
                        changed: false,
                        failed: true,
                        msg: "apt_repository: failed to install sources file".to_string(),
                        stdout: Some(install.stdout),
                        stderr: Some(install.stderr),
                    });
                }
            }

            if update_cache {
                let upd = ctx.exec("sudo apt-get update -y", None).await?;
                if upd.code != 0 {
                    return Ok(ModuleResponse {
                        changed: true,
                        failed: true,
                        msg: "apt_repository: apt-get update failed".to_string(),
                        stdout: Some(upd.stdout),
                        stderr: Some(upd.stderr),
                    });
                }
            }
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: if check_mode && changed { "check_mode: would change".to_string() } else if changed { "sources updated".to_string() } else { "no change".to_string() },
            stdout: None,
            stderr: None,
        })
    }
}
