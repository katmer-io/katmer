pub mod executor;
pub mod context;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Task {
    pub name: Option<String>,
    pub targets: Vec<String>,
    pub when: Option<String>,
    pub loop_control: Option<serde_json::Value>, // simplification for now
    pub register: Option<String>,
    pub allow_failure: Option<bool>,
    pub variables: Option<HashMap<String, serde_json::Value>>,
    pub environment: Option<HashMap<String, String>>,
    #[serde(flatten)]
    pub modules: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct TaskFile {
    pub tasks: Option<Vec<Task>>,
    pub defaults: Option<serde_json::Value>,
}
