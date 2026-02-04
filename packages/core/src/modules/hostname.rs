use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct HostnameModule;

#[async_trait::async_trait]
impl KatmerModule for HostnameModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let name = params.get("name").and_then(|v| v.as_str());
        let persist = params.get("persist").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut changed = false;

        // 1. Gather current facts
        let facts_cmd = "cur_short=\"$(hostname -s 2>/dev/null || true)\"; cur_fqdn=\"$(hostname -f 2>/dev/null || hostname 2>/dev/null || true)\"; printf '{\"short\":\"%s\",\"fqdn\":\"%s\"}' \"$cur_short\" \"$cur_fqdn\"";
        let res = ctx.exec(facts_cmd, None).await?;
        let current: Value = serde_json::from_str(&res.stdout).unwrap_or(serde_json::json!({"short": "", "fqdn": ""}));

        let current_short = current.get("short").and_then(|v| v.as_str()).unwrap_or("");
        let current_fqdn = current.get("fqdn").and_then(|v| v.as_str()).unwrap_or("");

        if let Some(target_name) = name {
            if target_name != current_short && target_name != current_fqdn {
                // Set runtime hostname
                let has_hostnamectl = ctx.exec("command -v hostnamectl >/dev/null 2>&1; echo $?", None).await?.stdout.trim() == "0";
                let cmd = if has_hostnamectl {
                    format!("sudo hostnamectl set-hostname {}", target_name)
                } else {
                    format!("sudo hostname {}", target_name)
                };
                
                let set_res = ctx.exec(&cmd, None).await?;
                if set_res.code != 0 {
                    anyhow::bail!("Failed to set hostname: {}", set_res.stderr);
                }
                changed = true;

                if persist {
                    // Best effort persist to /etc/hostname
                    let write_res = ctx.exec(&format!("echo {} | sudo tee /etc/hostname", target_name), None).await?;
                    if write_res.code != 0 {
                         // We might not fail the whole thing if runtime worked but persist failed, 
                         // but legacy seems to throw. In Rust we'll be strict.
                         anyhow::bail!("Failed to persist hostname to /etc/hostname: {}", write_res.stderr);
                    }
                }
            }
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: format!("Hostname set to {}", name.unwrap_or(current_short)),
            stdout: Some(res.stdout),
            stderr: None,
        })
    }
}
