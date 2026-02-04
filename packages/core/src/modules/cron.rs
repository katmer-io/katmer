use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::{Context, Result};
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct CronModule;

fn dq(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn strip_block(lines: Vec<String>, start: &str, end: &str) -> Vec<String> {
    if start.is_empty() || end.is_empty() {
        return lines;
    }
    let mut out = Vec::new();
    let mut skipping = false;
    for line in lines {
        if !skipping && line.trim() == start {
            skipping = true;
            continue;
        }
        if skipping && line.trim() == end {
            skipping = false;
            continue;
        }
        if !skipping {
            out.push(line);
        }
    }
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    out
}

fn split_lines(s: &str) -> Vec<String> {
    s.replace('\r', "").split('\n').map(|l| l.to_string()).collect()
}

fn derive_hhmm(minute: Option<&str>, hour: Option<&str>) -> Option<String> {
    let m = minute?.trim();
    let h = hour?.trim();
    if m.len() > 2 || h.len() > 2 {
        return None;
    }
    let mm: u32 = m.parse().ok()?;
    let hh: u32 = h.parse().ok()?;
    if mm > 59 || hh > 23 {
        return None;
    }
    Some(format!("{:02}:{:02}", hh, mm))
}

#[async_trait::async_trait]
impl KatmerModule for CronModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let os = ctx.provider.get_os_info().await.context("failed to get os info")?;
        if os.family == "windows" {
            return execute_windows(ctx, params).await;
        }
        execute_posix(ctx, params).await
    }
}

async fn execute_posix(ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
    let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("present");
    let name = params.get("name").and_then(|v| v.as_str());
    let job = params.get("job").and_then(|v| v.as_str());
    let user = params.get("user").and_then(|v| v.as_str());
    let special_time = params.get("special_time").and_then(|v| v.as_str());
    let minute = params.get("minute").and_then(|v| v.as_str()).unwrap_or("*");
    let hour = params.get("hour").and_then(|v| v.as_str()).unwrap_or("*");
    let day = params.get("day").and_then(|v| v.as_str()).unwrap_or("*");
    let month = params.get("month").and_then(|v| v.as_str()).unwrap_or("*");
    let weekday = params.get("weekday").and_then(|v| v.as_str()).unwrap_or("*");
    let disabled = params.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);

    if state != "absent" {
        if name.is_none() || job.is_none() {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "cron: 'name' and 'job' are required when state != absent".to_string(),
                stdout: None,
                stderr: None,
            });
        }
    }

    let run_as = user.map(|u| format!("sudo -u {} ", dq(u))).unwrap_or_default();
    let get_cmd = format!("{}crontab -l 2>/dev/null || true", run_as);
    let current = ctx.exec(&get_cmd, None).await?;
    let original = (current.stdout).replace('\r', "");
    let mut lines = split_lines(&original);

    if let Some(n) = name {
        let start = format!("# KATMER_CRON_START:{}", n);
        let end = format!("# KATMER_CRON_END:{}", n);
        lines = strip_block(lines, &start, &end);
    }

    let mut changed = false;

    if state == "absent" {
        if name.is_some() {
            changed = original != lines.join("\n");
        } else {
            if !original.trim().is_empty() {
                lines.clear();
                changed = true;
            }
        }
    } else {
        let n = name.unwrap();
        let j = job.unwrap();

        let start = format!("# KATMER_CRON_START:{}", n);
        let end = format!("# KATMER_CRON_END:{}", n);

        let cron_expr = if let Some(st) = special_time {
            match st {
                "reboot" => "@reboot".to_string(),
                other => format!("@{}", other),
            }
        } else {
            format!("{} {} {} {} {}", minute, hour, day, month, weekday)
        };

        let prefix = if disabled { "# " } else { "" };
        let cron_line = format!("{}{} {}", prefix, cron_expr, j);

        if !lines.is_empty() && !lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push(start);
        lines.push(cron_line);
        lines.push(end);

        changed = original != lines.join("\n");
    }

    if changed {
        let mut final_body = lines.join("\n");
        if !final_body.ends_with('\n') {
            final_body.push('\n');
        }

        let tmp = format!("/tmp/katmer-cron-{}.tmp", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis());
        let stage = format!("cat > {} <<'KATMER_EOF'\n{}KATMER_EOF", dq(&tmp), final_body);
        let r_stage = ctx.exec(&stage, None).await?;
        if r_stage.code != 0 {
            let _ = ctx.exec(&format!("rm -f {}", dq(&tmp)), None).await;
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "cron: failed to stage new crontab".to_string(),
                stdout: Some(r_stage.stdout),
                stderr: Some(r_stage.stderr),
            });
        }

        let install = ctx.exec(&format!("{}crontab {}", run_as, dq(&tmp)), None).await?;
        let _ = ctx.exec(&format!("rm -f {}", dq(&tmp)), None).await;
        if install.code != 0 {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "cron: failed to install new crontab".to_string(),
                stdout: Some(install.stdout),
                stderr: Some(install.stderr),
            });
        }
    }

    Ok(ModuleResponse {
        changed,
        failed: false,
        msg: if changed { "crontab updated".to_string() } else { "no change".to_string() },
        stdout: None,
        stderr: None,
    })
}

async fn execute_windows(ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
    let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("present");
    let name = params.get("name").and_then(|v| v.as_str());
    let job = params.get("job").and_then(|v| v.as_str());
    let user = params.get("user").and_then(|v| v.as_str());
    let at = params.get("at").and_then(|v| v.as_str());
    let frequency = params.get("frequency").and_then(|v| v.as_str()).unwrap_or("DAILY");
    let minute = params.get("minute").and_then(|v| v.as_str());
    let hour = params.get("hour").and_then(|v| v.as_str());

    if name.is_none() {
        return Ok(ModuleResponse {
            changed: false,
            failed: true,
            msg: "cron(windows): 'name' is required".to_string(),
            stdout: None,
            stderr: None,
        });
    }
    let name = name.unwrap();

    if state == "absent" {
        let del = ctx.exec(&format!("schtasks /Delete /TN {} /F", dq(name)), None).await?;
        let out = format!("{}{}", del.stdout, del.stderr);
        if del.code == 0 {
            return Ok(ModuleResponse { changed: true, failed: false, msg: "deleted".to_string(), stdout: Some(del.stdout), stderr: Some(del.stderr) });
        }
        if out.to_lowercase().contains("cannot find") {
            return Ok(ModuleResponse { changed: false, failed: false, msg: "no change".to_string(), stdout: Some(del.stdout), stderr: Some(del.stderr) });
        }
        return Ok(ModuleResponse { changed: false, failed: true, msg: "failed to delete scheduled task".to_string(), stdout: Some(del.stdout), stderr: Some(del.stderr) });
    }

    if job.is_none() {
        return Ok(ModuleResponse {
            changed: false,
            failed: true,
            msg: "cron(windows): 'job' is required".to_string(),
            stdout: None,
            stderr: None,
        });
    }
    let job = job.unwrap();

    let st = if let Some(at) = at {
        at.to_string()
    } else {
        derive_hhmm(minute, hour).unwrap_or_else(|| "12:00".to_string())
    };

    let mut create_cmd = format!(
        "schtasks /Create /TN {} /TR {} /SC {} /ST {}",
        dq(name),
        dq(job),
        frequency,
        dq(&st)
    );
    if let Some(u) = user {
        create_cmd.push_str(&format!(" /RU {}", dq(u)));
    }

    let mut r = ctx.exec(&create_cmd, None).await?;
    if r.code != 0 {
        let out = format!("{}{}", r.stdout, r.stderr);
        if out.to_lowercase().contains("already exists") {
            let del = ctx.exec(&format!("schtasks /Delete /TN {} /F", dq(name)), None).await?;
            if del.code == 0 {
                r = ctx.exec(&create_cmd, None).await?;
            } else {
                r = del;
            }
        }
    }

    Ok(ModuleResponse {
        changed: r.code == 0,
        failed: r.code != 0,
        msg: if r.code == 0 { "scheduled task updated".to_string() } else { "scheduled task failed".to_string() },
        stdout: Some(r.stdout),
        stderr: Some(r.stderr),
    })
}
