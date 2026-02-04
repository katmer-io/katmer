use crate::providers::{KatmerProvider, OsInfo, ProviderResponse};
use serde_json::Value;
use async_trait::async_trait;
use std::collections::HashMap;
use anyhow::{Context, Result};
use std::fmt::Debug;
use tokio::net::TcpStream;
use async_ssh2_lite::AsyncSession;
use tokio::io::AsyncReadExt;
use tokio_util::compat::{FuturesAsyncReadCompatExt, FuturesAsyncWriteCompatExt};

pub struct SshProvider {
    host: String,
    port: u16,
    username: String,
    private_key: Option<String>,
    password: Option<String>,
    session: Option<AsyncSession<TcpStream>>,
    initialized: bool,
    os: Option<OsInfo>,
}

impl SshProvider {
    pub fn new(host: String, port: u16, username: String) -> Self {
        Self {
            host,
            port,
            username,
            private_key: None,
            password: None,
            session: None,
            initialized: false,
            os: None,
        }
    }

    pub fn with_key(mut self, key_path: String) -> Self {
        self.private_key = Some(key_path);
        self
    }
    
    pub fn with_password(mut self, password: String) -> Self {
        self.password = Some(password);
        self
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

impl Debug for SshProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshProvider")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .finish()
    }
}

#[async_trait]
impl KatmerProvider for SshProvider {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    async fn check(&self) -> Result<()> {
        if self.private_key.is_none() && self.password.is_none() {
            anyhow::bail!("SSH provider requires either a private key or password");
        }
        Ok(())
    }

    async fn initialize(&mut self) -> Result<()> {
        self.initialized = true;
        Ok(())
    }

    async fn connect(&mut self) -> Result<()> {
        let addr = format!("{}:{}", self.host, self.port);
        let stream = TcpStream::connect(addr).await?;
        let mut session = AsyncSession::new(stream, None)?;
        session.handshake().await?;

        if let Some(ref key_path) = self.private_key {
             session.userauth_pubkey_file(&self.username, None, std::path::Path::new(key_path), None).await?;
        } else if let Some(ref pass) = self.password {
             session.userauth_password(&self.username, pass).await?;
        } else {
            anyhow::bail!("No authentication method provided");
        };

        if !session.authenticated() {
            anyhow::bail!("SSH authentication failed");
        }

        self.session = Some(session);
        Ok(())
    }

    async fn execute(&self, command: &str, options: Option<&HashMap<String, String>>) -> Result<ProviderResponse> {
        let session = self.session.as_ref().context("SSH session not connected")?;
        
        // Defaults
        let shell = options.and_then(|o| o.get("shell")).map(|s| s.as_str()).unwrap_or("bash");
        let timeout_ms = options.and_then(|o| o.get("timeout")).and_then(|t| t.parse::<u64>().ok()).unwrap_or(0);
        let interactive_password = options.and_then(|o| o.get("interactivePassword")).map(|s| s.as_str());
        let prompt_marker = options
            .and_then(|o| o.get("promptMarker"))
            .map(|s| s.as_str())
            .unwrap_or("KATMER_SUDO_PROMPT:");
        
        let prepared_command = self.prepare_command(command, shell);
        
        // Single DEBUG log for command execution (no duplication)
        tracing::debug!(shell = %shell, "Executing command");
        
        let start = std::time::Instant::now();
        
        let exec_fut = async {
            let mut channel = session.channel_session().await?;
            
            // If we have an interactive password, we might need a PTY for sudo
            if interactive_password.is_some() {
                channel.request_pty("xterm", None, None).await?;
            }
            
            channel.exec(&prepared_command).await?;

            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let mut stdout_str = String::new();
            let mut stderr_str = String::new();
            
            // For interactive prompt handling, we need a custom loop
            if let Some(pwd) = interactive_password {
                let mut stdout_buffer = [0u8; 4096];
                let mut stderr_buffer = [0u8; 4096];
                let mut total_buffer = String::new();
                let mut pwd_sent = false;
                let mut stdout_closed = false;
                let mut stderr_closed = false;

                let mut stderr_channel = channel.stderr();

                loop {
                    tokio::select! {
                        res = channel.read(&mut stdout_buffer), if !stdout_closed => {
                            let n = res?;
                            if n == 0 {
                                stdout_closed = true;
                            } else {
                                let text = String::from_utf8_lossy(&stdout_buffer[..n]);
                                total_buffer.push_str(&text);
                                stdout.extend_from_slice(&stdout_buffer[..n]);
                            }
                        }
                        res = stderr_channel.read(&mut stderr_buffer), if !stderr_closed => {
                            let n = res?;
                            if n == 0 {
                                stderr_closed = true;
                            } else {
                                let text = String::from_utf8_lossy(&stderr_buffer[..n]);
                                total_buffer.push_str(&text);
                                stderr.extend_from_slice(&stderr_buffer[..n]);
                            }
                        }
                    }

                    if !pwd_sent {
                        // Prefer marker inserted by become wrapper
                        if total_buffer.contains(prompt_marker) || total_buffer.to_lowercase().contains("[sudo] password") {
                            use tokio::io::AsyncWriteExt;
                            channel.write_all(format!("{}\n", pwd).as_bytes()).await?;
                            pwd_sent = true;
                        }
                    }

                    if total_buffer.len() > 16384 {
                        total_buffer.drain(..8192);
                    }

                    if stdout_closed && stderr_closed {
                        break;
                    }
                }
            } else {
                channel.read_to_string(&mut stdout_str).await?;
                channel.stderr().read_to_string(&mut stderr_str).await?;
            }
            
            channel.wait_close().await?;
            let exit_code = channel.exit_status()?;

            let final_stdout = if interactive_password.is_some() { String::from_utf8_lossy(&stdout).to_string() } else { stdout_str };
            let final_stderr = if interactive_password.is_some() { String::from_utf8_lossy(&stderr).to_string() } else { stderr_str };

            Ok::<ProviderResponse, anyhow::Error>(ProviderResponse {
                stdout: final_stdout,
                stderr: final_stderr,
                code: exit_code,
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

    async fn upload_file(&self, local_path: &std::path::Path, remote_path: &str) -> Result<()> {
        let session = self.session.as_ref().context("SSH session not connected")?;
        let sftp = session.sftp().await?;
        let mut remote_file = sftp.create(std::path::Path::new(remote_path)).await?.compat_write();
        let mut local_file = tokio::fs::File::open(local_path).await?;
        tokio::io::copy(&mut local_file, &mut remote_file).await?;
        Ok(())
    }

    async fn download_file(&self, remote_path: &str, local_path: &std::path::Path) -> Result<()> {
        let session = self.session.as_ref().context("SSH session not connected")?;
        let sftp = session.sftp().await?;
        let mut remote_file = sftp.open(std::path::Path::new(remote_path)).await?.compat();
        let mut local_file = tokio::fs::File::create(local_path).await?;
        tokio::io::copy(&mut remote_file, &mut local_file).await?;
        Ok(())
    }

    async fn destroy(&mut self) -> Result<()> {
        if let Some(session) = self.session.take() {
            let _ = session.disconnect(None, "Disconnecting", None).await;
        }
        Ok(())
    }

    async fn get_os_info(&self) -> Result<OsInfo> {
        let posix_script = r#"OS="$(uname -s 2>/dev/null || true)"; ARCH="$(uname -m 2>/dev/null || true)"; F=""; [ -r /etc/os-release ] && F=/etc/os-release; [ -z "$F" ] && [ -r /usr/lib/os-release ] && F=/usr/lib/os-release; ID=""; VERSION_ID=""; PRETTY_NAME=""; [ -n "$F" ] && . "$F"; printf "__os=%s\n__arch=%s\n__id=%s\n__ver=%s\n__pretty=%s\n" "$OS" "$ARCH" "$ID" "$VERSION_ID" "$PRETTY_NAME""#;
        
        let mut options = HashMap::new();
        options.insert("shell".into(), "none".into());
        options.insert("timeout".into(), "5000".into());

        let res = self.execute(posix_script, Some(&options)).await;
        if let Ok(r) = res {
            if r.code == 0 {
                let mut kv = HashMap::new();
                for line in r.stdout.lines() {
                    if let Some((k, v)) = line.split_once('=') {
                        kv.insert(k, v);
                    }
                }
                
                let kernel = kv.get("__os").unwrap_or(&"unknown").to_string();
                let family = if kernel.to_lowercase().contains("linux") { "linux".to_string() } else { kernel.to_lowercase() };
                
                return Ok(OsInfo {
                    family,
                    arch: kv.get("__arch").unwrap_or(&"unknown").to_string(),
                    kernel,
                    distro_id: kv.get("__id").map(|s| s.to_string()),
                    version_id: kv.get("__ver").map(|s| s.to_string()),
                    pretty_name: kv.get("__pretty").map(|s| s.to_string()),
                    source: "posix".to_string(),
                });
            }
        }

        // PowerShell fallback
        let ps_script = r#"$arch=$env:PROCESSOR_ARCHITECTURE; $osCaption=(Get-CimInstance Win32_OperatingSystem).Caption; $ver=(Get-CimInstance Win32_OperatingSystem).Version; $obj=@{os='Windows';arch=$arch;id='windows';version=$ver;pretty=$osCaption}; $obj | ConvertTo-Json -Compress"#;
        options.insert("shell".into(), "powershell".into());
        let res = self.execute(ps_script, Some(&options)).await;
        if let Ok(r) = res {
            if r.code == 0 {
                let data: Value = serde_json::from_str(&r.stdout).unwrap_or(serde_json::json!({}));
                return Ok(OsInfo {
                    family: "windows".to_string(),
                    arch: data.get("arch").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
                    kernel: "Windows".to_string(),
                    distro_id: Some("windows".to_string()),
                    version_id: data.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    pretty_name: data.get("pretty").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    source: "powershell".to_string(),
                });
            }
        }

        Ok(OsInfo {
            family: "unknown".to_string(),
            arch: "unknown".to_string(),
            kernel: "unknown".to_string(),
            distro_id: None,
            version_id: None,
            pretty_name: None,
            source: "unknown".to_string(),
        })
    }
}
