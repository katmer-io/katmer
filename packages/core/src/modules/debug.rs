use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;
use crate::utils::renderer::Renderer;

pub struct DebugModule;

#[async_trait::async_trait]
impl KatmerModule for DebugModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let msg = params.get("msg").or_else(|| {
            if params.is_string() || params.is_array() {
                Some(params)
            } else {
                None
            }
        });

        let var_names = params.get("var");
        let vars = params.get("vars");
        let label = params.get("label").and_then(|v| v.as_str());
        let _pretty = params.get("pretty").and_then(|v| v.as_bool()).unwrap_or(true);
        let _quiet = params.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut lines = Vec::new();

        if let Some(l) = label {
            lines.push(l.to_string());
        }

        let mut renderer = Renderer::new();
        let vars_val = serde_json::to_value(&ctx.variables)?;

        // Handle msg
        if let Some(m) = msg {
            if let Some(s) = m.as_str() {
                lines.push(renderer.render(s, &vars_val)?);
            } else if let Some(arr) = m.as_array() {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        lines.push(renderer.render(s, &vars_val)?);
                    }
                }
            }
        }

        // Handle var (dot notation simplified for now)
        let mut structured_values = serde_json::Map::new();
        if let Some(v) = var_names {
            if let Some(name) = v.as_str() {
                if let Some(val) = ctx.variables.get(name) {
                    structured_values.insert(name.to_string(), val.clone());
                }
            } else if let Some(arr) = v.as_array() {
                for item in arr {
                    if let Some(name) = item.as_str() {
                        if let Some(val) = ctx.variables.get(name) {
                            structured_values.insert(name.to_string(), val.clone());
                        }
                    }
                }
            }
        }

        // Handle vars (direct map)
        if let Some(v) = vars {
            if let Some(obj) = v.as_object() {
                for (k, val) in obj {
                    structured_values.insert(k.clone(), val.clone());
                }
            }
        }

        if !structured_values.is_empty() {
            lines.push(serde_json::to_string_pretty(&Value::Object(structured_values))?);
        }

        if lines.is_empty() {
            lines.push("ok".to_string());
        }

        let output = lines.join("\n");
        tracing::info!("{}", output); // Log to tracing

        Ok(ModuleResponse {
            changed: false,
            failed: false,
            msg: output,
            stdout: None,
            stderr: None,
        })
    }
}
