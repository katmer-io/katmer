use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn test_shell_name() -> &'static str {
    if cfg!(windows) {
        "powershell"
    } else {
        "sh"
    }
}

pub fn temp_dir(prefix: &str) -> PathBuf {
    let base = std::env::temp_dir();
    let pid = std::process::id();
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dir = base.join(format!("katmer-core-tests-{}-{}-{}", prefix, pid, ms));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn write_text(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content.as_bytes()).unwrap();
}

pub fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap()
}

pub fn local_config_yaml(hostname: &str, extra_vars: Option<HashMap<String, serde_json::Value>>) -> String {
    let shell = test_shell_name();
    let mut vars = HashMap::new();
    vars.insert("shell".to_string(), serde_json::Value::String(shell.to_string()));
    if let Some(extra) = extra_vars {
        for (k, v) in extra {
            vars.insert(k, v);
        }
    }
    let vars_yaml = serde_yaml::to_string(&vars).unwrap();
    format!(
        "targets:\n  hosts:\n    {}:\n      connection: local\n  variables:\n{}",
        hostname,
        indent_yaml(&vars_yaml, 4)
    )
}

fn indent_yaml(s: &str, spaces: usize) -> String {
    let pad = " ".repeat(spaces);
    s.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| format!("{}{}\n", pad, l))
        .collect::<String>()
}

#[derive(Debug, Clone)]
pub struct SshTestConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

pub fn ssh_config_from_env() -> Option<SshTestConfig> {
    let host = std::env::var("KATMER_TEST_SSH_HOST").ok()?;
    let user = std::env::var("KATMER_TEST_SSH_USER").ok()?;
    let password = std::env::var("KATMER_TEST_SSH_PASSWORD").ok()?;
    let port = std::env::var("KATMER_TEST_SSH_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(22);
    Some(SshTestConfig { host, port, user, password })
}
