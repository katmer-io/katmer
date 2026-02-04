use crate::modules::{KatmerModule, ModuleResponse};
use crate::providers::{KatmerProvider, local::LocalProvider, ssh::SshProvider};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use sha2::{Sha256, Digest};
use hex;
use tokio::fs;
use crate::utils::renderer::Renderer;
use crate::task::context::TaskContext;

pub struct TemplateModule;

#[async_trait::async_trait]
impl KatmerModule for TemplateModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let dest = params.get("dest").and_then(|v| v.as_str()).context("template: 'dest' is required")?;
        let src = params.get("src").and_then(|v| v.as_str()).context("template: 'src' is required")?;

        let template_content = fs::read_to_string(src).await?;

        // Note: KatmerCore has variables, but they are also passed in host resolved
        // For now, we use the variables from TaskContext
        let mut renderer = Renderer::new();
        let rendered = renderer.render_with_cwd(
            &template_content,
            &serde_json::to_value(&ctx.variables)?,
            ctx.config.cwd.as_deref(),
        )?;

        if let Some(_local) = ctx.provider.as_any().downcast_ref::<LocalProvider>() {
            return self.run_local(dest, &rendered).await;
        }

        if let Some(ssh) = ctx.provider.as_any().downcast_ref::<SshProvider>() {
            return self.run_ssh(ssh, dest, &rendered).await;
        }

        anyhow::bail!("template: unsupported provider")
    }
}

impl TemplateModule {
    async fn run_local(&self, dest: &str, rendered: &str) -> Result<ModuleResponse> {
        let mut changed = false;
        let dest_path = Path::new(dest);

        let data = rendered.as_bytes();
        let mut hasher = Sha256::new();
        hasher.update(data);
        let content_hash = hex::encode(hasher.finalize());

        let current_hash = if dest_path.exists() {
             Some(self.hash_file_local(dest).await?)
        } else {
            None
        };

        if current_hash != Some(content_hash) {
            fs::write(dest_path, data).await?;
            changed = true;
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: "Template rendered and saved locally".to_string(),
            stdout: None,
            stderr: None,
        })
    }

    async fn run_ssh(&self, ssh: &SshProvider, dest: &str, rendered: &str) -> Result<ModuleResponse> {
        let mut changed = false;
        
        let data = rendered.as_bytes();
        let mut hasher = Sha256::new();
        hasher.update(data);
        let content_hash = hex::encode(hasher.finalize());

        let remote_hash = self.get_remote_hash(ssh, dest).await.ok();

        if remote_hash != Some(content_hash.clone()) {
            let temp_dir = std::env::temp_dir();
            let temp_file = temp_dir.join(format!("katmer_tmpl_{}", &content_hash[..8]));
            fs::write(&temp_file, data).await?;
            ssh.upload_file(&temp_file, dest).await?;
            fs::remove_file(&temp_file).await?;
            changed = true;
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: "Template rendered and uploaded to remote".to_string(),
            stdout: None,
            stderr: None,
        })
    }

    async fn get_remote_hash(&self, ssh: &SshProvider, path: &str) -> Result<String> {
        let res = ssh.execute(&format!("sha256sum {} || shasum -a 256 {}", path, path), None).await?;
        if res.code == 0 {
            if let Some(hash) = res.stdout.split_whitespace().next() {
                let hash_str: &str = hash;
                if hash_str.len() == 64 {
                    return Ok(hash_str.to_string());
                }
            }
        }
        anyhow::bail!("Failed to get remote hash")
    }

    async fn hash_file_local(&self, path: &str) -> Result<String> {
        let data = fs::read(path).await?;
        let mut hasher = Sha256::new();
        hasher.update(data);
        Ok(hex::encode(hasher.finalize()))
    }
}

use anyhow::Context;
