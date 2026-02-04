use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;

use crate::task::context::TaskContext;

pub struct ShellModule;

#[async_trait::async_trait]
impl KatmerModule for ShellModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let command = if let Some(cmd) = params.as_str() {
            cmd
        } else if let Some(cmd) = params.get("command").and_then(|v| v.as_str()) {
            cmd
        } else {
            anyhow::bail!("Shell module requires a command");
        };

        let res = ctx.exec(command, None).await?;
        
        Ok(ModuleResponse {
            changed: true, // Assuming shell always changes for now, or check code
            failed: res.code != 0,
            msg: if res.code == 0 { "Command executed successfully".to_string() } else { "Command failed".to_string() },
            stdout: Some(res.stdout),
            stderr: Some(res.stderr),
        })
    }
}
