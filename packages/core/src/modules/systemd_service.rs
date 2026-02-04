use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct SystemdServiceModule;

fn dq(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

async fn is_active(ctx: &TaskContext<'_>, scope_flag: &str, unit: &str) -> Result<bool> {
    let cmd = format!("systemctl {} is-active {} || true", scope_flag, dq(unit));
    let r = ctx.exec(&cmd, None).await?;
    Ok(r.stdout.trim() == "active")
}

async fn is_enabled(ctx: &TaskContext<'_>, scope_flag: &str, unit: &str) -> Result<bool> {
    let cmd = format!("systemctl {} is-enabled {} || true", scope_flag, dq(unit));
    let r = ctx.exec(&cmd, None).await?;
    let s = r.stdout.trim();
    Ok(s == "enabled" || s == "static" || s == "indirect")
}

async fn is_masked(ctx: &TaskContext<'_>, scope_flag: &str, unit: &str) -> Result<bool> {
    let cmd = format!("systemctl {} is-enabled {} || true", scope_flag, dq(unit));
    let r = ctx.exec(&cmd, None).await?;
    Ok(r.stdout.trim() == "masked")
}

async fn run_systemctl(ctx: &TaskContext<'_>, cmd: &str) -> Result<(i32, String, String)> {
    let r = ctx.exec(cmd, None).await?;
    Ok((r.code, r.stdout, r.stderr))
}

#[async_trait::async_trait]
impl KatmerModule for SystemdServiceModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let check = ctx.exec("command -v systemctl >/dev/null 2>&1; echo $?", None).await?;
        if check.stdout.trim() != "0" {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "systemd_service: systemctl not found".to_string(),
                stdout: Some(check.stdout),
                stderr: Some(check.stderr),
            });
        }

        let name = match params.get("name").and_then(|v| v.as_str()) {
            Some(n) if !n.trim().is_empty() => n.trim(),
            _ => {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: "systemd_service: 'name' is required".to_string(),
                    stdout: None,
                    stderr: None,
                });
            }
        };

        let unit = if name.contains('.') { name.to_string() } else { format!("{}.service", name) };
        let scope = params.get("scope").and_then(|v| v.as_str()).unwrap_or("system");
        let scope_flag = if scope == "user" { "--user" } else { "" };
        let no_block = params.get("no_block").and_then(|v| v.as_bool()).unwrap_or(false);
        let block_flag = if no_block { "--no-block" } else { "" };
        let daemon_reload = params.get("daemon_reload").and_then(|v| v.as_bool()).unwrap_or(false);
        let enabled = params.get("enabled").and_then(|v| v.as_bool());
        let masked = params.get("masked").and_then(|v| v.as_bool());
        let state = params.get("state").and_then(|v| v.as_str());

        let mut changed = false;

        if daemon_reload {
            let cmd = format!("systemctl {} daemon-reload", scope_flag);
            let (code, out, err) = run_systemctl(ctx, &cmd).await?;
            if code != 0 {
                return Ok(ModuleResponse {
                    changed,
                    failed: true,
                    msg: "systemd_service: daemon-reload failed".to_string(),
                    stdout: Some(out),
                    stderr: Some(err),
                });
            }
            changed = true;
        }

        let active0 = is_active(ctx, scope_flag, &unit).await?;
        let enabled0 = is_enabled(ctx, scope_flag, &unit).await?;
        let masked0 = is_masked(ctx, scope_flag, &unit).await?;

        if let Some(masked) = masked {
            if masked && !masked0 {
                let cmd = format!("systemctl {} mask {} {}", scope_flag, block_flag, dq(&unit));
                let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                if code != 0 {
                    return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: mask failed".to_string(), stdout: Some(out), stderr: Some(err) });
                }
                changed = true;
            } else if !masked && masked0 {
                let cmd = format!("systemctl {} unmask {} {}", scope_flag, block_flag, dq(&unit));
                let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                if code != 0 {
                    return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: unmask failed".to_string(), stdout: Some(out), stderr: Some(err) });
                }
                changed = true;
            }
        }

        if let Some(enabled) = enabled {
            if enabled && !enabled0 {
                let cmd = format!("systemctl {} enable {} {}", scope_flag, block_flag, dq(&unit));
                let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                if code != 0 {
                    return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: enable failed".to_string(), stdout: Some(out), stderr: Some(err) });
                }
                changed = true;
            } else if !enabled && enabled0 {
                let cmd = format!("systemctl {} disable {} {}", scope_flag, block_flag, dq(&unit));
                let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                if code != 0 {
                    return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: disable failed".to_string(), stdout: Some(out), stderr: Some(err) });
                }
                changed = true;
            }
        }

        if let Some(state) = state {
            if state == "started" {
                if !active0 {
                    let cmd = format!("systemctl {} start {} {}", scope_flag, block_flag, dq(&unit));
                    let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                    if code != 0 {
                        return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: start failed".to_string(), stdout: Some(out), stderr: Some(err) });
                    }
                    changed = true;
                }
            } else if state == "stopped" {
                if active0 {
                    let cmd = format!("systemctl {} stop {} {}", scope_flag, block_flag, dq(&unit));
                    let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                    if code != 0 {
                        return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: stop failed".to_string(), stdout: Some(out), stderr: Some(err) });
                    }
                    changed = true;
                }
            } else if state == "restarted" {
                let cmd = format!("systemctl {} restart {} {}", scope_flag, block_flag, dq(&unit));
                let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                if code != 0 {
                    return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: restart failed".to_string(), stdout: Some(out), stderr: Some(err) });
                }
                changed = true;
            } else if state == "reloaded" {
                let cmd = format!("systemctl {} reload {} {}", scope_flag, block_flag, dq(&unit));
                let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                if code != 0 {
                    return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: reload failed".to_string(), stdout: Some(out), stderr: Some(err) });
                }
                changed = true;
            } else if state == "paused" {
                if active0 {
                    let cmd = format!("systemctl {} stop {} {}", scope_flag, block_flag, dq(&unit));
                    let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                    if code != 0 {
                        return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: pause(stop) failed".to_string(), stdout: Some(out), stderr: Some(err) });
                    }
                    changed = true;
                }
            } else if state == "unpaused" {
                if !active0 {
                    let cmd = format!("systemctl {} start {} {}", scope_flag, block_flag, dq(&unit));
                    let (code, out, err) = run_systemctl(ctx, &cmd).await?;
                    if code != 0 {
                        return Ok(ModuleResponse { changed, failed: true, msg: "systemd_service: unpause(start) failed".to_string(), stdout: Some(out), stderr: Some(err) });
                    }
                    changed = true;
                }
            }
        }

        let active1 = is_active(ctx, scope_flag, &unit).await?;
        let enabled1 = is_enabled(ctx, scope_flag, &unit).await?;
        let masked1 = is_masked(ctx, scope_flag, &unit).await?;

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: format!("systemd_service: active={}, enabled={}, masked={}, scope={}", active1, enabled1, masked1, scope),
            stdout: None,
            stderr: None,
        })
    }
}
