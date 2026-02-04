mod test_support;

use katmer_core::config::KatmerConfig;
use katmer_core::modules::registry::ModuleRegistry;
use katmer_core::providers::local::LocalProvider;
use katmer_core::providers::KatmerProvider;
use katmer_core::task::context::TaskContext;
use std::collections::HashMap;

fn base_ctx<'a>(provider: &'a LocalProvider, cfg: &'a KatmerConfig) -> TaskContext<'a> {
    let mut vars: HashMap<String, serde_json::Value> = HashMap::new();
    vars.insert(
        "shell".to_string(),
        serde_json::Value::String(test_support::test_shell_name().to_string()),
    );
    TaskContext::new(provider, cfg, vars)
}

fn echo_command(s: &str) -> String {
    if cfg!(windows) {
        format!("Write-Output \"{}\"", s.replace('"', "\"\""))
    } else {
        format!("echo {}", shell_quote(s))
    }
}

fn shell_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

#[tokio::test]
async fn local_provider_exec_works() {
    let cfg = KatmerConfig::default();
    let mut p = LocalProvider::new();
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let mut ctx = base_ctx(&p, &cfg);
    let r = ctx.exec(&echo_command("hello"), None).await.unwrap();
    assert_eq!(r.code, 0);
    assert!(r.stdout.to_lowercase().contains("hello"));
}

#[tokio::test]
async fn shell_module_runs_command() {
    let cfg = KatmerConfig::default();
    let mut p = LocalProvider::new();
    p.initialize().await.unwrap();
    p.connect().await.unwrap();
    let mut ctx = base_ctx(&p, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("shell").unwrap();
    let params = serde_json::json!({"command": echo_command("katmer")});
    let res = m.execute(&mut ctx, &params).await.unwrap();
    assert!(!res.failed);
    assert!(res.changed);
    assert!(res.stdout.unwrap_or_default().to_lowercase().contains("katmer"));
}

#[tokio::test]
async fn script_module_renders_when_enabled() {
    let cfg = KatmerConfig::default();
    let mut p = LocalProvider::new();
    p.initialize().await.unwrap();
    p.connect().await.unwrap();
    let mut ctx = base_ctx(&p, &cfg);
    ctx.variables.insert("name".to_string(), serde_json::Value::String("katmer".to_string()));

    let reg = ModuleRegistry::new();
    let m = reg.get("script").unwrap();

    let content = if cfg!(windows) {
        "Write-Output \"hello {{ name }}\"".to_string()
    } else {
        "echo 'hello {{ name }}'".to_string()
    };
    let params = serde_json::json!({"content": content, "render": true});
    let res = m.execute(&mut ctx, &params).await.unwrap();
    assert!(!res.failed);
    assert!(!res.changed);
    assert!(res.stdout.unwrap_or_default().contains("hello katmer"));
}

#[tokio::test]
async fn copy_module_is_idempotent_for_content() {
    let dir = test_support::temp_dir("copy");
    let dest = dir.join("out.txt");

    let cfg = KatmerConfig::default();
    let mut p = LocalProvider::new();
    p.initialize().await.unwrap();
    p.connect().await.unwrap();
    let mut ctx = base_ctx(&p, &cfg);

    let reg = ModuleRegistry::new();
    let m = reg.get("copy").unwrap();
    let params = serde_json::json!({"dest": dest.to_string_lossy().to_string(), "content": "hello"});

    let r1 = m.execute(&mut ctx, &params).await.unwrap();
    assert!(r1.changed);

    let r2 = m.execute(&mut ctx, &params).await.unwrap();
    assert!(!r2.changed);

    assert_eq!(test_support::read_text(&dest), "hello");
}

#[tokio::test]
async fn template_module_is_idempotent() {
    let dir = test_support::temp_dir("template");
    let src = dir.join("t.tmpl");
    let dest = dir.join("out.txt");
    test_support::write_text(&src, "hello {{ inventory_hostname }}\n");

    let cfg = KatmerConfig::default();
    let mut p = LocalProvider::new();
    p.initialize().await.unwrap();
    p.connect().await.unwrap();
    let mut ctx = base_ctx(&p, &cfg);
    ctx.variables.insert("inventory_hostname".to_string(), serde_json::Value::String("local".to_string()));

    let reg = ModuleRegistry::new();
    let m = reg.get("template").unwrap();
    let params = serde_json::json!({"src": src.to_string_lossy().to_string(), "dest": dest.to_string_lossy().to_string()});

    let r1 = m.execute(&mut ctx, &params).await.unwrap();
    assert!(r1.changed);
    assert_eq!(test_support::read_text(&dest), "hello local\n");

    let r2 = m.execute(&mut ctx, &params).await.unwrap();
    assert!(!r2.changed);
}
