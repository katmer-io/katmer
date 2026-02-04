use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct KatmerConfig {
    pub cwd: Option<PathBuf>,
    pub logging: Option<LoggingConfig>,
    pub targets: Targets,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct LoggingConfig {
    pub dir: Option<String>,
    pub level: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum Targets {
    Root(RootTargets),
    Grouped(HashMap<String, Group>),
}

impl Default for Targets {
    fn default() -> Self {
        Targets::Root(RootTargets::default())
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct RootTargets {
    pub hosts: HashMap<String, HostInput>,
    pub settings: Option<HashMap<String, serde_json::Value>>,
    pub variables: Option<HashMap<String, serde_json::Value>>,
    pub environment: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct Group {
    pub children: Option<HashMap<String, Option<serde_json::Value>>>,
    pub hosts: Option<HashMap<String, HostInput>>,
    pub settings: Option<HashMap<String, serde_json::Value>>,
    pub variables: Option<HashMap<String, serde_json::Value>>,
    pub environment: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(tag = "connection", rename_all = "snake_case")]
pub enum HostInput {
    Ssh(SshConfig),
    Local(LocalConfig),
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SshConfig {
    pub hostname: String,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_password: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
pub struct LocalConfig {
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Resolved host information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KatmerHostResolved {
    pub name: String,
    pub connection: HostInput,
    pub variables: HashMap<String, serde_json::Value>,
    pub environment: HashMap<String, String>,
}
