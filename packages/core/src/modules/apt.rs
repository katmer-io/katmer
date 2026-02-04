use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct AptModule;

#[async_trait::async_trait]
impl KatmerModule for AptModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("present");
        let update_cache = params.get("update_cache").and_then(|v| v.as_bool()).unwrap_or(false);
        let name = params.get("name");
        let upgrade = params.get("upgrade").and_then(|v| v.as_str()).unwrap_or("no");
        let autoremove = params.get("autoremove").and_then(|v| v.as_bool()).unwrap_or(false);
        let purge = params.get("purge").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut changed = false;
        let mut stdout_acc = String::new();
        let mut stderr_acc = String::new();

        // 1. Update cache if requested
        if update_cache {
            let res = ctx.exec("sudo apt-get update -y", None).await?;
            stdout_acc.push_str(&res.stdout);
            stderr_acc.push_str(&res.stderr);
            if res.code != 0 {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: "apt-get update failed".to_string(),
                    stdout: Some(stdout_acc),
                    stderr: Some(stderr_acc),
                });
            }
        }

        // 2. Handle upgrade
        if upgrade != "no" {
            let sub = match upgrade {
                "yes" | "safe" => "upgrade",
                "full" => "full-upgrade",
                "dist" => "dist-upgrade",
                _ => "upgrade",
            };
            let res = ctx.exec(&format!("sudo apt-get {} -y", sub), None).await?;
            stdout_acc.push_str(&res.stdout);
            stderr_acc.push_str(&res.stderr);
            if res.code != 0 {
                return Ok(ModuleResponse {
                    changed,
                    failed: true,
                    msg: format!("apt-get {} failed", sub),
                    stdout: Some(stdout_acc),
                    stderr: Some(stderr_acc),
                });
            }
            changed = true;
        }

        // 3. Handle packages
        if let Some(n) = name {
            let pkgs = if let Some(s) = n.as_str() {
                vec![s.to_string()]
            } else if let Some(arr) = n.as_array() {
                arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
            } else {
                vec![]
            };

            if !pkgs.is_empty() {
                let pkg_args = pkgs.join(" ");
                let (verb, extra) = match state {
                    "present" => ("install", ""),
                    "latest" => ("install", "--only-upgrade"),
                    "absent" => ("remove", if purge { "--purge" } else { "" }),
                    "build-dep" => ("build-dep", ""),
                    _ => ("install", ""),
                };

                // Check if already installed (simplification: we just run apt-get install -y which is idempotent-ish)
                // In a real module we might want to check dpkg -s <pkg> first to avoid 'changed: true' when nothing happened.
                let cmd = format!("sudo apt-get {} -y {} {}", verb, extra, pkg_args);
                let res = ctx.exec(&cmd, None).await?;
                stdout_acc.push_str(&res.stdout);
                stderr_acc.push_str(&res.stderr);
                
                if res.code != 0 {
                    return Ok(ModuleResponse {
                        changed,
                        failed: true,
                        msg: format!("apt-get {} failed", verb),
                        stdout: Some(stdout_acc),
                        stderr: Some(stderr_acc),
                    });
                }
                
                // Detection of actual change is hard without parsing output. 
                // For now we assume changed if it returned 0 and we sent a command.
                if !res.stdout.contains("is already the newest version") && !res.stdout.contains("0 upgraded, 0 newly installed, 0 to remove") {
                    changed = true;
                }
            }
        }

        // 4. Autoremove
        if autoremove {
            let res = ctx.exec("sudo apt-get autoremove -y", None).await?;
            if res.code == 0 && (res.stdout.contains("upgraded") || res.stdout.contains("newly installed") || res.stdout.contains("removed")) {
                 changed = true;
            }
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: "Apt operation completed".to_string(),
            stdout: Some(stdout_acc),
            stderr: Some(stderr_acc),
        })
    }
}
