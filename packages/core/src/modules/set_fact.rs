use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;
use crate::utils::renderer::Renderer;

pub struct SetFactModule;

#[async_trait::async_trait]
impl KatmerModule for SetFactModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let vars_to_set = if let Some(v) = params.get("vars") {
            v.as_object().ok_or_else(|| anyhow::anyhow!("set_fact: 'vars' must be an object"))?
        } else if params.is_object() {
            params.as_object().unwrap()
        } else {
            anyhow::bail!("set_fact: expects an object or 'vars' key");
        };

        let render = params.get("render").and_then(|v| v.as_bool()).unwrap_or(true);
        // let deep = params.get("deep").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut renderer = Renderer::new();
        let mut changed = false;

        for (k, v) in vars_to_set {
            let next_val = if render {
                if let Some(s) = v.as_str() {
                    let rendered = renderer.render(s, &serde_json::to_value(&ctx.variables)?)?;
                    Value::String(rendered)
                } else {
                    v.clone()
                }
            } else {
                v.clone()
            };

            if let Some(prev) = ctx.variables.get(k) {
                if prev != &next_val {
                    changed = true;
                }
            } else {
                changed = true;
            }

            ctx.variables.insert(k.clone(), next_val);
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: "Facts set".to_string(),
            stdout: None,
            stderr: None,
        })
    }
}
