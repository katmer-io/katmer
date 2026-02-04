use async_trait::async_trait;
use katmer_core::config::KatmerConfig;
use katmer_core::modules::registry::ModuleRegistry;
use katmer_core::providers::{KatmerProvider, OsInfo, ProviderResponse};
use katmer_core::task::context::TaskContext;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone, Debug)]
struct ExecCapture {
    last_command: Arc<Mutex<Option<String>>>,
    last_options: Arc<Mutex<Option<HashMap<String, String>>>>,
}

#[derive(Default, Debug)]
struct CaptureProvider {
    cap: ExecCapture,
}

impl CaptureProvider {
    fn capture(&self) -> ExecCapture {
        self.cap.clone()
    }
}

#[async_trait]
impl KatmerProvider for CaptureProvider {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    async fn check(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn initialize(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn connect(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn execute(
        &self,
        command: &str,
        options: Option<&HashMap<String, String>>,
    ) -> anyhow::Result<ProviderResponse> {
        *self.cap.last_command.lock().unwrap() = Some(command.to_string());
        *self.cap.last_options.lock().unwrap() = options.cloned();
        Ok(ProviderResponse { stdout: "".into(), stderr: "".into(), code: 0 })
    }

    async fn upload_file(&self, _local_path: &std::path::Path, _remote_path: &str) -> anyhow::Result<()> {
        Ok(())
    }

    async fn download_file(&self, _remote_path: &str, _local_path: &std::path::Path) -> anyhow::Result<()> {
        Ok(())
    }

    async fn destroy(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn get_os_info(&self) -> anyhow::Result<OsInfo> {
        Ok(OsInfo {
            family: "linux".to_string(),
            arch: "x86_64".to_string(),
            kernel: "linux".to_string(),
            distro_id: Some("debian".to_string()),
            version_id: Some("12".to_string()),
            pretty_name: Some("Debian".to_string()),
            source: "test".to_string(),
        })
    }
}

fn new_ctx<'a>(provider: &'a dyn KatmerProvider, cfg: &'a KatmerConfig) -> TaskContext<'a> {
    TaskContext::new(provider, cfg, HashMap::new())
}

#[tokio::test]
async fn become_false_disables_rewrite() {
    let provider = CaptureProvider::default();
    let cap = provider.capture();
    let cfg = KatmerConfig::default();
    let mut ctx = new_ctx(&provider, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("become").unwrap();
    let res = m.execute(&mut ctx, &serde_json::json!(false)).await.unwrap();
    assert!(!res.failed);
    assert_eq!(ctx.variables.get("become_enabled").and_then(|v| v.as_bool()), Some(false));

    ctx.exec("echo hi", None).await.unwrap();
    let cmd = cap.last_command.lock().unwrap().clone().unwrap();
    assert_eq!(cmd, "echo hi");
}

#[tokio::test]
async fn become_true_prefixes_sudo_with_default_prompt() {
    let provider = CaptureProvider::default();
    let cap = provider.capture();
    let cfg = KatmerConfig::default();
    let mut ctx = new_ctx(&provider, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("become").unwrap();
    let res = m.execute(&mut ctx, &serde_json::json!(true)).await.unwrap();
    assert!(!res.failed);
    assert_eq!(ctx.variables.get("become_enabled").and_then(|v| v.as_bool()), Some(true));

    ctx.exec("echo hi", None).await.unwrap();
    let cmd = cap.last_command.lock().unwrap().clone().unwrap();
    assert_eq!(cmd, "sudo -S -p \"KATMER_SUDO_PROMPT:\" echo hi");
}

#[tokio::test]
async fn become_object_sets_user_prompt_password_and_passes_interactive_password_option() {
    let provider = CaptureProvider::default();
    let cap = provider.capture();
    let cfg = KatmerConfig::default();
    let mut ctx = new_ctx(&provider, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("become").unwrap();
    let res = m
        .execute(
            &mut ctx,
            &serde_json::json!({
                "user": "root",
                "prompt": "SUDO:",
                "password": "pw"
            }),
        )
        .await
        .unwrap();
    assert!(!res.failed);

    ctx.exec("id -u", None).await.unwrap();
    let cmd = cap.last_command.lock().unwrap().clone().unwrap();
    assert_eq!(cmd, "sudo -S -p \"SUDO:\" -u \"root\" id -u");

    let opts = cap.last_options.lock().unwrap().clone().unwrap_or_default();
    assert_eq!(opts.get("interactivePassword").map(|s| s.as_str()), Some("pw"));
}

#[tokio::test]
async fn become_does_not_double_wrap_sudo_commands() {
    let provider = CaptureProvider::default();
    let cap = provider.capture();
    let cfg = KatmerConfig::default();
    let mut ctx = new_ctx(&provider, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("become").unwrap();
    m.execute(&mut ctx, &serde_json::json!(true)).await.unwrap();

    ctx.exec("sudo id -u", None).await.unwrap();
    let cmd = cap.last_command.lock().unwrap().clone().unwrap();
    assert_eq!(cmd, "sudo id -u");
}

#[tokio::test]
async fn become_rejects_invalid_param_type() {
    let provider = CaptureProvider::default();
    let cfg = KatmerConfig::default();
    let mut ctx = new_ctx(&provider, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("become").unwrap();
    let res = m.execute(&mut ctx, &serde_json::json!("yes")).await.unwrap();
    assert!(res.failed);
    assert!(res.msg.contains("expected boolean or object"));
}
