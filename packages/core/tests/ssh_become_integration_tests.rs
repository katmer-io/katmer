mod test_support;

use katmer_core::config::KatmerConfig;
use katmer_core::modules::registry::ModuleRegistry;
use katmer_core::providers::ssh::SshProvider;
use katmer_core::providers::KatmerProvider;
use katmer_core::task::context::TaskContext;
use std::collections::HashMap;

fn require_ssh() -> test_support::SshTestConfig {
    test_support::ssh_config_from_env().expect(
        "set KATMER_TEST_SSH_HOST, KATMER_TEST_SSH_USER, KATMER_TEST_SSH_PASSWORD (optional: KATMER_TEST_SSH_PORT)",
    )
}

async fn is_root(ctx: &TaskContext<'_>) -> bool {
    let r = ctx.exec("id -u", None).await.unwrap();
    r.code == 0 && r.stdout.trim() == "0"
}

#[tokio::test]
#[ignore]
async fn become_true_allows_id_u_to_be_root_using_auth_password() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password.clone());
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let cfg = KatmerConfig::default();
    let mut vars: HashMap<String, serde_json::Value> = HashMap::new();
    vars.insert("shell".to_string(), serde_json::Value::String("bash".to_string()));
    vars.insert("interactivePassword".to_string(), serde_json::Value::String(c.password));
    vars.insert("timeout".to_string(), serde_json::Value::Number(serde_json::Number::from(8000)));
    let mut ctx = TaskContext::new(&p, &cfg, vars);

    // Sanity: we are not root initially (common case); if we are, still proceed.
    let _before = is_root(&ctx).await;

    let reg = ModuleRegistry::new();
    reg.get("become")
        .unwrap()
        .execute(&mut ctx, &serde_json::json!(true))
        .await
        .unwrap();

    let r = ctx.exec("id -u", None).await.unwrap();
    assert_eq!(r.code, 0);
    assert_eq!(r.stdout.trim(), "0");
}

#[tokio::test]
#[ignore]
async fn become_custom_prompt_marker_still_works() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password.clone());
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let cfg = KatmerConfig::default();
    let mut vars: HashMap<String, serde_json::Value> = HashMap::new();
    vars.insert("shell".to_string(), serde_json::Value::String("bash".to_string()));
    vars.insert("interactivePassword".to_string(), serde_json::Value::String(c.password));
    vars.insert("timeout".to_string(), serde_json::Value::Number(serde_json::Number::from(8000)));
    let mut ctx = TaskContext::new(&p, &cfg, vars);

    let reg = ModuleRegistry::new();
    reg.get("become")
        .unwrap()
        .execute(
            &mut ctx,
            &serde_json::json!({"prompt": "KATMER_SUDO_PROMPT_CUSTOM:", "user": "root"}),
        )
        .await
        .unwrap();

    let r = ctx.exec("id -u", None).await.unwrap();
    assert_eq!(r.code, 0);
    assert_eq!(r.stdout.trim(), "0");
}

#[tokio::test]
#[ignore]
async fn become_does_not_double_wrap_when_command_starts_with_sudo() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password.clone());
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let cfg = KatmerConfig::default();
    let mut vars: HashMap<String, serde_json::Value> = HashMap::new();
    vars.insert("shell".to_string(), serde_json::Value::String("bash".to_string()));
    vars.insert("interactivePassword".to_string(), serde_json::Value::String(c.password));
    vars.insert("timeout".to_string(), serde_json::Value::Number(serde_json::Number::from(8000)));
    let mut ctx = TaskContext::new(&p, &cfg, vars);
    let reg = ModuleRegistry::new();
    reg.get("become")
        .unwrap()
        .execute(&mut ctx, &serde_json::json!(true))
        .await
        .unwrap();

    let r = ctx.exec("sudo id -u", None).await.unwrap();
    assert_eq!(r.code, 0);
    assert_eq!(r.stdout.trim(), "0");
}

#[tokio::test]
#[ignore]
async fn become_wrong_password_fails_fast_with_timeout() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password);
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let cfg = KatmerConfig::default();
    let mut vars: HashMap<String, serde_json::Value> = HashMap::new();
    vars.insert("shell".to_string(), serde_json::Value::String("bash".to_string()));
    vars.insert("timeout".to_string(), serde_json::Value::Number(serde_json::Number::from(5000)));
    let mut ctx = TaskContext::new(&p, &cfg, vars);
    // override with wrong password
    ctx.variables
        .insert("interactivePassword".to_string(), serde_json::Value::String("definitely-wrong".to_string()));

    let reg = ModuleRegistry::new();
    reg.get("become")
        .unwrap()
        .execute(&mut ctx, &serde_json::json!({"prompt": "KATMER_SUDO_PROMPT:", "user": "root"}))
        .await
        .unwrap();

    // -k forces sudo to prompt even if cached
    let r = ctx.exec("sudo -k id -u", None).await.unwrap();
    assert_ne!(r.code, 0);
    // implementation-specific; accept either sudo error or timeout
    let combined = format!("{}{}", r.stdout, r.stderr).to_lowercase();
    assert!(
        combined.contains("sorry") || combined.contains("incorrect") || combined.contains("timed out") || combined.contains("password"),
        "unexpected output: {}",
        combined
    );
}

#[tokio::test]
#[ignore]
async fn become_nopasswd_works_without_interactive_password() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password);
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let cfg = KatmerConfig::default();
    let mut vars: HashMap<String, serde_json::Value> = HashMap::new();
    vars.insert("shell".to_string(), serde_json::Value::String("bash".to_string()));
    vars.insert("timeout".to_string(), serde_json::Value::Number(serde_json::Number::from(8000)));
    let mut ctx = TaskContext::new(&p, &cfg, vars);
    // check if host/user is configured for nopasswd
    let probe = ctx.exec("sudo -n true", None).await.unwrap();
    if probe.code != 0 {
        // not configured; skip
        return;
    }

    ctx.variables.remove("interactivePassword");
    let reg = ModuleRegistry::new();
    reg.get("become")
        .unwrap()
        .execute(&mut ctx, &serde_json::json!(true))
        .await
        .unwrap();

    let r = ctx.exec("id -u", None).await.unwrap();
    assert_eq!(r.code, 0);
    assert_eq!(r.stdout.trim(), "0");
}
