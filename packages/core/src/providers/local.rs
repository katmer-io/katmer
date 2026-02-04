use crate::providers::{KatmerProvider, OsInfo, ProviderResponse};
use async_trait::async_trait;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug)]
pub struct LocalProvider {
    initialized: bool,
}

impl LocalProvider {
    pub fn new() -> Self {
        Self { initialized: false }
    }

    fn prepare_command(&self, command: &str, shell: &str) -> String {
        match shell {
            // TODO: [shell command wrapping] simplistic wrapping, not fool proof
            "bash" | "zsh" | "sh" | "dash" | "ksh" | "mksh" | "fish" => {
                let flag = if shell == "bash" || shell == "zsh" { "-lc" } else { "-c" };
                let escaped = command.replace('\'', "'\\''");
                format!("{} {} '{}'", shell, flag, escaped)
            }
            "powershell" => {
                let escaped = command.replace('\'', "''");
                format!("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '{}'", escaped)
            }
            "cmd" => {
                let escaped = command.replace('"', "\\\""); // Simple escaping
                format!("cmd /d /s /c \"{}\"", escaped)
            }
            _ => command.to_string(),
        }
    }
}

#[async_trait]
impl KatmerProvider for LocalProvider {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    async fn check(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn initialize(&mut self) -> anyhow::Result<()> {
        self.initialized = true;
        Ok(())
    }

    async fn connect(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn execute(&self, command: &str, options: Option<&HashMap<String, String>>) -> anyhow::Result<ProviderResponse> {
        let shell = options.and_then(|o| o.get("shell")).map(|s| s.as_str()).unwrap_or("sh");
        let timeout_ms = options.and_then(|o| o.get("timeout")).and_then(|t| t.parse::<u64>().ok()).unwrap_or(0);
        
        let prepared_command = self.prepare_command(command, shell);
        
        // Single DEBUG log for command execution
        tracing::debug!(shell = %shell, "Executing command");
        
        let start = std::time::Instant::now();

        let exec_fut = async {
            let mut child = if shell == "cmd" {
                let mut c = Command::new("cmd");
                c.args(["/C", &prepared_command]);
                c
            } else if shell == "powershell" {
                let mut c = Command::new("powershell");
                c.args(["-Command", &prepared_command]);
                c
            } else {
                let mut c = Command::new("sh");
                c.args(["-c", &prepared_command]);
                c
            };

            let output = child
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await?;

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            Ok::<ProviderResponse, anyhow::Error>(ProviderResponse {
                stdout,
                stderr,
                code: output.status.code().unwrap_or(-1),
            })
        };

        let result = if timeout_ms > 0 {
            match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), exec_fut).await {
                Ok(res) => res,
                Err(_) => Ok(ProviderResponse {
                    stdout: "".into(),
                    stderr: format!("Command timed out after {}ms", timeout_ms),
                    code: 1,
                }),
            }
        } else {
            exec_fut.await
        };
        
        let duration = start.elapsed();
        
        // Log result at appropriate level
        if let Ok(ref response) = result {
            tracing::debug!(
                exit_code = response.code,
                duration_ms = duration.as_millis(),
                "Command completed"
            );
            
            // TRACE level: full output in single log entry
            if !response.stdout.is_empty() {
                let line_count = response.stdout.lines().count();
                tracing::trace!(
                    lines = line_count,
                    "stdout ({} lines):\n{}",
                    line_count,
                    response.stdout
                );
            }
            
            if !response.stderr.is_empty() {
                let line_count = response.stderr.lines().count();
                tracing::trace!(
                    lines = line_count,
                    "stderr ({} lines):\n{}",
                    line_count,
                    response.stderr
                );
            }
        }
        
        result
    }

    async fn upload_file(&self, local_path: &std::path::Path, remote_path: &str) -> anyhow::Result<()> {
        tokio::fs::copy(local_path, remote_path).await?;
        Ok(())
    }

    async fn download_file(&self, remote_path: &str, local_path: &std::path::Path) -> anyhow::Result<()> {
        tokio::fs::copy(remote_path, local_path).await?;
        Ok(())
    }

    async fn destroy(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn get_os_info(&self) -> anyhow::Result<OsInfo> {
        let family = std::env::consts::FAMILY.to_string();
        let arch = std::env::consts::ARCH.to_string();
        let kernel = std::env::consts::OS.to_string();
        
        let family = if kernel == "linux" { "linux".to_string() } else { family };
        
        let mut info = OsInfo {
            family: family.clone(),
            arch: arch.clone(),
            kernel: kernel.clone(),
            distro_id: None,
            version_id: None,
            pretty_name: None,
            source: "local".to_string(),
        };

        if family == "unix" {
            // Try to parse /etc/os-release
            if let Ok(content) = tokio::fs::read_to_string("/etc/os-release").await {
                for line in content.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        let v = v.trim_matches('"').trim_matches('\'');
                        match k {
                            "ID" => info.distro_id = Some(v.to_string()),
                            "VERSION_ID" => info.version_id = Some(v.to_string()),
                            "PRETTY_NAME" => info.pretty_name = Some(v.to_string()),
                            _ => {}
                        }
                    }
                }
            }
        } else if family == "windows" {
            info.distro_id = Some("windows".to_string());
            // We could use powershell here too if we wanted more detail, 
            // but for local we can also use env vars or registry if needed.
        }

        Ok(info)
    }
}
