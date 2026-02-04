use crate::providers::{KatmerProvider, ProviderResponse};
use crate::config::KatmerConfig;
use std::collections::HashMap;
use tracing::info;

fn shell_double_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

pub struct TaskContext<'a> {
    pub provider: &'a dyn KatmerProvider,
    pub config: &'a KatmerConfig,
    pub variables: HashMap<String, serde_json::Value>,
}

impl<'a> TaskContext<'a> {
    pub fn new(provider: &'a dyn KatmerProvider, config: &'a KatmerConfig, variables: HashMap<String, serde_json::Value>) -> Self {
        Self {
            provider,
            config,
            variables,
        }
    }

    pub async fn exec(&self, command: &str, overrides: Option<&HashMap<String, String>>) -> anyhow::Result<ProviderResponse> {
        let mut command = command.to_string();
        let become_enabled = self.variables.get("become_enabled").and_then(|v| v.as_bool()).unwrap_or(false);
        if become_enabled {
            let trimmed = command.trim_start();
            if !trimmed.starts_with("sudo ") && !trimmed.starts_with("sudo\t") {
                let prompt = self.variables.get("become_prompt").and_then(|v| v.as_str()).unwrap_or("KATMER_SUDO_PROMPT:");
                let user = self.variables.get("become_user").and_then(|v| v.as_str()).unwrap_or("");
                let user_part = if user.is_empty() {
                    String::new()
                } else {
                    format!(" -u {}", shell_double_quote(user))
                };
                command = format!("sudo -S -p {}{} {}", shell_double_quote(prompt), user_part, command);
            }
        }

        let mut options = HashMap::new();
        
        if let Some(shell) = self.variables.get("shell").and_then(|v| v.as_str()) {
            options.insert("shell".to_string(), shell.to_string());
        }
        if let Some(timeout) = self.variables.get("timeout").and_then(|v| v.as_str()) {
            options.insert("timeout".to_string(), timeout.to_string());
        } else if let Some(timeout) = self.variables.get("timeout").and_then(|v| v.as_u64()) {
            options.insert("timeout".to_string(), timeout.to_string());
        }

        // interactive sudo handling is only needed when become is enabled
        if become_enabled {
            let prompt = self
                .variables
                .get("become_prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("KATMER_SUDO_PROMPT:");
            options.insert("promptMarker".to_string(), prompt.to_string());

            if let Some(pwd) = self.variables.get("interactivePassword").and_then(|v| v.as_str()) {
                options.insert("interactivePassword".to_string(), pwd.to_string());
            }
        }

        if let Some(o) = overrides {
            for (k, v) in o {
                options.insert(k.clone(), v.clone());
            }
        }

        self.provider.execute(&command, Some(&options)).await
    }

    pub fn log(&self, msg: &str) {
        info!("{}", msg);
    }
}
