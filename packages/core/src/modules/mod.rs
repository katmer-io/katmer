pub mod shell;
pub mod r#become;
pub mod copy;
pub mod archive;
pub mod cron;
pub mod http;
pub mod package;
pub mod script;
pub mod systemd_service;
pub mod template;
pub mod debug;
pub mod apt;
pub mod apt_repository;
pub mod git;
pub mod set_fact;
pub mod hostname;
pub mod registry;
pub mod gather_facts;
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleResponse {
    pub changed: bool,
    pub failed: bool,
    pub msg: String,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

use crate::task::context::TaskContext;

#[async_trait::async_trait]
pub trait KatmerModule: Send + Sync {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &serde_json::Value) -> Result<ModuleResponse>;
}
