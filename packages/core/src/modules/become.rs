use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct BecomeModule;

#[async_trait::async_trait]
impl KatmerModule for BecomeModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let (enabled, user, prompt, password) = match params {
            Value::Bool(false) => (false, None, None, None),
            Value::Bool(true) => (true, None, None, None),
            Value::Object(map) => {
                let user = map.get("user").and_then(|v| v.as_str()).map(|s| s.to_string());
                let prompt = map.get("prompt").and_then(|v| v.as_str()).map(|s| s.to_string());
                let password = map.get("password").and_then(|v| v.as_str()).map(|s| s.to_string());
                (true, user, prompt, password)
            }
            _ => {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: "become: expected boolean or object".to_string(),
                    stdout: None,
                    stderr: None,
                });
            }
        };

        if !enabled {
            ctx.variables.insert("become_enabled".to_string(), Value::Bool(false));
            ctx.variables.remove("become_user");
            ctx.variables.remove("become_prompt");
            Ok(ModuleResponse {
                changed: false,
                failed: false,
                msg: "Become disabled".to_string(),
                stdout: None,
                stderr: None,
            })
        } else {
            ctx.variables.insert("become_enabled".to_string(), Value::Bool(true));
            if let Some(user) = user {
                ctx.variables.insert("become_user".to_string(), Value::String(user));
            }
            if let Some(prompt) = prompt {
                ctx.variables.insert("become_prompt".to_string(), Value::String(prompt));
            }
            if let Some(password) = password {
                if !password.is_empty() {
                    ctx.variables.insert("interactivePassword".to_string(), Value::String(password));
                }
            }
            Ok(ModuleResponse {
                changed: false,
                failed: false,
                msg: "Privilege escalation configured".to_string(),
                stdout: None,
                stderr: None,
            })
        }
    }
}
