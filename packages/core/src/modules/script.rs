use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct ScriptModule;

fn normalize(params: &Value) -> Result<(String, bool)> {
    if let Some(s) = params.as_str() {
        return Ok((s.to_string(), true));
    }
    if let Some(obj) = params.as_object() {
        let content = obj.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if content.trim().is_empty() {
            anyhow::bail!("script: 'content' must be a non-empty string");
        }
        let render = obj.get("render").and_then(|v| v.as_bool()).unwrap_or(true);
        return Ok((content.to_string(), render));
    }
    anyhow::bail!("script: expected string or object")
}

#[async_trait::async_trait]
impl KatmerModule for ScriptModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let (content, render) = match normalize(params) {
            Ok(v) => v,
            Err(e) => {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: e.to_string(),
                    stdout: None,
                    stderr: None,
                });
            }
        };

        let script_text = if render {
            let mut renderer = crate::utils::renderer::Renderer::new();
            let vars = serde_json::to_value(&ctx.variables)?;
            renderer.render_with_cwd(&content, &vars, ctx.config.cwd.as_deref())?
        } else {
            content
        };

        let r = ctx.exec(&script_text, None).await?;

        Ok(ModuleResponse {
            changed: false,
            failed: r.code != 0,
            msg: if r.code == 0 { "script executed".to_string() } else { "script failed".to_string() },
            stdout: Some(r.stdout),
            stderr: Some(r.stderr),
        })
    }
}
