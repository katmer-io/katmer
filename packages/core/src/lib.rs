use std::path::PathBuf;
use std::path::Path;

#[cfg(feature = "node")]
mod node;

pub mod config;
pub mod utils;
pub mod target_resolver;
pub mod modules;
pub mod task;
pub mod providers;
pub mod inventory;

use config::KatmerConfig;
use utils::file::read_katmer_file;
use target_resolver::KatmerTargetResolver;
use modules::registry::ModuleRegistry;
use task::{TaskFile, executor::TaskExecutor};

pub fn sum(a: i32, b: i32) -> i32 {
    a + b
}

pub struct KatmerCore {
    config_path: String,
    _cwd: PathBuf,
    config: Option<KatmerConfig>,
    resolver: Option<KatmerTargetResolver>,
    registry: ModuleRegistry,
    inventory: Option<crate::inventory::Inventory>,
}

impl KatmerCore {
    pub fn new(config_path: String, cwd: PathBuf) -> Self {
        Self { 
            config_path, 
            _cwd: cwd,
            config: None,
            resolver: None,
            registry: ModuleRegistry::new(),
            inventory: None,
        }
    }

    fn resolve_path(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self._cwd.join(p)
        }
    }

    fn apply_config(&mut self, config: KatmerConfig) -> anyhow::Result<()> {
        let resolver = KatmerTargetResolver::new(&config);

        // Initialize inventory with all hosts
        let all_hosts = resolver.resolve_targets("all");
        self.inventory = Some(crate::inventory::Inventory::new(all_hosts));

        self.resolver = Some(resolver);
        self.config = Some(config);
        Ok(())
    }

    pub fn init(&mut self) -> anyhow::Result<()> {
        if self.config_path.is_empty() {
            anyhow::bail!("No config path provided")
        }

        let resolved = self.resolve_path(&self.config_path);
        let value = read_katmer_file(resolved)?;
        let config: KatmerConfig = serde_json::from_value(value)?;
        self.apply_config(config)
    }

    pub fn load_config_json(&mut self, config_json: &str) -> anyhow::Result<()> {
        let value: serde_json::Value = serde_json::from_str(config_json)?;
        let config: KatmerConfig = serde_json::from_value(value)?;
        self.apply_config(config)
    }

    pub async fn check(&mut self) -> anyhow::Result<()> {
        use crate::providers::{KatmerProvider, local::LocalProvider, ssh::SshProvider};

        let inventory = self
            .inventory
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("KatmerCore not initialized"))?;

        for host_state in inventory.hosts.values() {
            let mut provider: Box<dyn KatmerProvider> = match &host_state.resolved.connection {
                crate::config::HostInput::Local(_) => Box::new(LocalProvider::new()),
                crate::config::HostInput::Ssh(ssh_cfg) => {
                    let mut p = SshProvider::new(
                        ssh_cfg.hostname.clone(),
                        ssh_cfg.port.unwrap_or(22),
                        ssh_cfg
                            .username
                            .clone()
                            .unwrap_or_else(|| "root".to_string()),
                    );
                    if let Some(key) = &ssh_cfg.private_key {
                        p = p.with_key(key.clone());
                    }
                    if let Some(pass) = &ssh_cfg.password {
                        p = p.with_password(pass.clone());
                    }
                    Box::new(p)
                }
            };

            provider.check().await?;
            provider.initialize().await?;
            provider.connect().await?;
            provider.destroy().await?;
        }

        Ok(())
    }

    pub async fn run(&mut self, file: &str) -> anyhow::Result<()> {
        let resolved = self.resolve_path(file);
        let value = read_katmer_file(resolved)?;
        let task_file: TaskFile = serde_json::from_value(value)?;

        let resolver = self
            .resolver
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("KatmerCore not initialized"))?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("KatmerCore not initialized"))?;
        let inventory = self
            .inventory
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("KatmerCore not initialized"))?;

        let mut executor = TaskExecutor::new(config, resolver, &self.registry, inventory);

        if let Some(tasks) = task_file.tasks {
            for task in tasks {
                executor.execute_task(&task).await?;
            }
        }

        Ok(())
    }
}
