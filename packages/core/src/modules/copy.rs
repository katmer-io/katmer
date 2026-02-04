use crate::modules::{KatmerModule, ModuleResponse};
use crate::providers::{KatmerProvider, local::LocalProvider, ssh::SshProvider};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use sha2::{Sha256, Digest};
use hex;
use tokio::fs;

use crate::task::context::TaskContext;

pub struct CopyModule;

#[async_trait::async_trait]
impl KatmerModule for CopyModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let dest = params.get("dest").and_then(|v| v.as_str()).context("copy: 'dest' is required")?;
        let src = params.get("src").and_then(|v| v.as_str());
        let content = params.get("content");

        if src.is_some() && content.is_some() {
            anyhow::bail!("copy: 'src' and 'content' are mutually exclusive");
        }

        // Implementation differs by provider
        
        // For LocalProvider
        if let Some(_local) = ctx.provider.as_any().downcast_ref::<LocalProvider>() {
            return self.run_local(dest, src, content).await;
        }
        
        // For SshProvider
        if let Some(ssh) = ctx.provider.as_any().downcast_ref::<SshProvider>() {
            return self.run_ssh(ssh, dest, src, content).await;
        }

        anyhow::bail!("copy: unsupported provider")
    }
}

impl CopyModule {
    async fn run_local(&self, dest: &str, src: Option<&str>, content: Option<&Value>) -> Result<ModuleResponse> {
        let mut changed = false;
        let dest_path = Path::new(dest);

        // Check hash for idempotency
        let current_hash = if dest_path.exists() {
             Some(self.hash_file_local(dest).await?)
        } else {
            None
        };

        if let Some(s) = src {
            let src_path = Path::new(s);
            let src_hash = self.hash_file_local(s).await?;
            if current_hash != Some(src_hash) {
                fs::copy(src_path, dest_path).await?;
                changed = true;
            }
        } else if let Some(c) = content {
            let data = match c {
                Value::String(s) => s.as_bytes(),
                _ => anyhow::bail!("copy: content must be a string for now"),
            };
            let mut hasher = Sha256::new();
            hasher.update(data);
            let content_hash = hex::encode(hasher.finalize());
            
            if current_hash != Some(content_hash) {
                fs::write(dest_path, data).await?;
                changed = true;
            }
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: "File copied successfully".to_string(),
            stdout: None,
            stderr: None,
        })
    }

    async fn run_ssh(&self, ssh: &SshProvider, dest: &str, src: Option<&str>, content: Option<&Value>) -> Result<ModuleResponse> {
        let mut changed = false;
        
        // Remote hash check (best effort)
        let remote_hash = self.get_remote_hash(ssh, dest).await.ok();

        if let Some(s) = src {
            let local_hash = self.hash_file_local(s).await?;
            if remote_hash != Some(local_hash) {
                ssh.upload_file(Path::new(s), dest).await?;
                changed = true;
            }
        } else if let Some(c) = content {
            let data = match c {
                Value::String(s) => s.as_bytes(),
                _ => anyhow::bail!("copy: content must be a string for now"),
            };
            let mut hasher = Sha256::new();
            hasher.update(data);
            let content_hash = hex::encode(hasher.finalize());
            
            if remote_hash != Some(content_hash.clone()) {
                // Write content to a temporary local file then upload
                let temp_dir = std::env::temp_dir();
                let temp_file = temp_dir.join(format!("katmer_copy_{}", hex::encode(content_hash.as_bytes().get(0..4).unwrap_or(b"temp"))));
                fs::write(&temp_file, data).await?;
                ssh.upload_file(&temp_file, dest).await?;
                fs::remove_file(&temp_file).await?;
                changed = true;
            }
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: "File copied successfully to remote".to_string(),
            stdout: None,
            stderr: None,
        })
    }

    async fn get_remote_hash(&self, ssh: &SshProvider, path: &str) -> Result<String> {
        // Try sha256sum or shasum
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
