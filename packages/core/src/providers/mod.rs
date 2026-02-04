use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Debug;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderResponse {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsInfo {
    pub family: String,
    pub arch: String,
    pub kernel: String,
    pub distro_id: Option<String>,
    pub version_id: Option<String>,
    pub pretty_name: Option<String>,
    pub source: String,
}

pub mod local;
pub mod ssh;

use std::any::Any;

use std::path::Path;

#[async_trait]
pub trait KatmerProvider: Send + Sync + Debug {
    fn as_any(&self) -> &dyn Any;
    async fn check(&self) -> anyhow::Result<()>;
    async fn initialize(&mut self) -> anyhow::Result<()>;
    async fn connect(&mut self) -> anyhow::Result<()>;
    async fn execute(&self, command: &str, options: Option<&HashMap<String, String>>) -> anyhow::Result<ProviderResponse>;
    async fn upload_file(&self, local_path: &Path, remote_path: &str) -> anyhow::Result<()>;
    async fn download_file(&self, remote_path: &str, local_path: &Path) -> anyhow::Result<()>;
    async fn destroy(&mut self) -> anyhow::Result<()>;
    async fn get_os_info(&self) -> anyhow::Result<OsInfo>;
}
