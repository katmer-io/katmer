use crate::task::{Task, context::TaskContext};
use crate::target_resolver::KatmerTargetResolver;
use crate::modules::registry::ModuleRegistry;
use crate::providers::{KatmerProvider, local::LocalProvider, ssh::SshProvider};
use crate::config::KatmerConfig;
use anyhow::Result;

pub struct TaskExecutor<'a> {
    config: &'a KatmerConfig,
    target_resolver: &'a KatmerTargetResolver,
    module_registry: &'a ModuleRegistry,
    inventory: &'a mut crate::inventory::Inventory,
}

impl<'a> TaskExecutor<'a> {
    pub fn new(config: &'a KatmerConfig, target_resolver: &'a KatmerTargetResolver, module_registry: &'a ModuleRegistry, inventory: &'a mut crate::inventory::Inventory) -> Self {
        Self {
            config,
            target_resolver,
            module_registry,
            inventory,
        }
    }

    pub async fn execute_task(&mut self, task: &Task) -> Result<()> {
        let task_name = task.name.as_deref().unwrap_or("unnamed");
        tracing::info!(task = %task_name, "Starting task: \"{}\"", task_name);
        
        for target_pattern in &task.targets {
            let resolved_hosts = self.target_resolver.resolve_targets(target_pattern);
            
            for host_resolved in resolved_hosts {
                let host_name = &host_resolved.name;
                
                let host_state = self.inventory.hosts.get(&host_resolved.name)
                    .ok_or_else(|| anyhow::anyhow!("Host {} not found in inventory", host_resolved.name))?;

                let mut provider: Box<dyn KatmerProvider> = match &host_state.resolved.connection {
                    crate::config::HostInput::Local(_) => Box::new(LocalProvider::new()),
                    crate::config::HostInput::Ssh(ssh_cfg) => {
                        let mut p = SshProvider::new(ssh_cfg.hostname.clone(), ssh_cfg.port.unwrap_or(22), ssh_cfg.username.clone().unwrap_or("root".to_string()));
                        if let Some(key) = &ssh_cfg.private_key {
                            p = p.with_key(key.clone());
                        }
                        if let Some(pass) = &ssh_cfg.password {
                            p = p.with_password(pass.clone());
                        }
                        Box::new(p)
                    }
                };

                provider.initialize().await?;
                provider.connect().await?;

                let mut base_ctx = TaskContext::new(provider.as_ref(), self.config, host_state.variables.clone());

                // for SSH hosts, make the auth password available for sudo prompts without persisting it.
                if let crate::config::HostInput::Ssh(ssh_cfg) = &host_state.resolved.connection {
                    if base_ctx.variables.get("interactivePassword").is_none() {
                        if let Some(pass) = &ssh_cfg.password {
                            base_ctx
                                .variables
                                .insert("interactivePassword".to_string(), serde_json::Value::String(pass.clone()));
                        }
                    }
                }

                //  'when'
                if let Some(when_expr) = &task.when {
                    if !self.evaluate_condition(when_expr, &base_ctx).await? {
                        tracing::info!(host = %host_name, "⊘ Skipped due to condition");
                        provider.destroy().await?;
                        continue;
                    }
                }

                //  'loop'
                let loop_items = if let Some(loop_val) = &task.loop_control {
                    self.resolve_loop(loop_val, &base_ctx).await?
                } else {
                    vec![serde_json::Value::Null] // Single execution
                };

                for item in loop_items {
                    if !item.is_null() {
                        base_ctx.variables.insert("item".to_string(), item.clone());
                    }

                    for (module_name, params) in &task.modules {
                        // Skip known task keys
                        // TODO: handle better
                        if ["name", "targets", "when", "loop_control", "register", "allow_failure", "variables", "environment"].contains(&module_name.as_str()) {
                            continue;
                        }

                        if let Some(module) = self.module_registry.get(module_name) {
                            let start = std::time::Instant::now();
                            
                            tracing::debug!(host = %host_name, module = %module_name, "Executing module");
                            
                            let res = module.execute(&mut base_ctx, params).await?;
                            let duration = start.elapsed();
                            
                            let (symbol, status) = if res.failed {
                                ("✗", "FAILED")
                            } else if res.changed {
                                ("✓", "CHANGED")
                            } else {
                                ("✓", "OK")
                            };
                            
                            let details = if !res.msg.is_empty() && res.msg != "ok" && res.msg != "OK" {
                                format!(" - {}", res.msg)
                            } else {
                                String::new()
                            };
                            
                            if res.failed {
                                tracing::error!(
                                    host = %host_name,
                                    module = %module_name,
                                    status = %status,
                                    duration_ms = duration.as_millis(),
                                    changed = res.changed,
                                    "[{}] {} {} ({:.2}s){}",
                                    host_name,
                                    symbol,
                                    module_name,
                                    duration.as_secs_f64(),
                                    details
                                );
                            } else {
                                tracing::info!(
                                    host = %host_name,
                                    module = %module_name,
                                    status = %status,
                                    duration_ms = duration.as_millis(),
                                    changed = res.changed,
                                    "[{}] {} {} ({:.2}s){}",
                                    host_name,
                                    symbol,
                                    module_name,
                                    duration.as_secs_f64(),
                                    details
                                );
                            }
                            
                            if res.failed {
                                if task.allow_failure.unwrap_or(false) {
                                    tracing::warn!(host = %host_name, module = %module_name, "Failure allowed, continuing");
                                } else {
                                    anyhow::bail!("Task failed on host {}: {}", host_resolved.name, res.msg);
                                }
                            }
                        }
                    }
                }
                
                self.inventory.update_variables(&host_resolved.name, base_ctx.variables);

                provider.destroy().await?;
            }
        }
        
        Ok(())
    }
    async fn evaluate_condition(&self, expr: &str, ctx: &TaskContext<'_>) -> Result<bool> {
        let mut renderer = crate::utils::renderer::Renderer::new();
        // wrap in {{ }} if not already?
        let template = if expr.contains("{{") { expr.to_string() } else { format!("{{{{ {} }}}}", expr) };
        let res = renderer.render(&template, &serde_json::to_value(&ctx.variables)?)?;
        
        let trimmed = res.trim().to_lowercase();
        Ok(trimmed == "true" || trimmed == "1" || trimmed == "yes")
    }

    async fn resolve_loop(&self, loop_val: &serde_json::Value, _ctx: &TaskContext<'_>) -> Result<Vec<serde_json::Value>> {
        match loop_val {
            serde_json::Value::Array(arr) => Ok(arr.clone()),
            _ => Ok(vec![loop_val.clone()]), // single item but wrapped
        }
    }
}
