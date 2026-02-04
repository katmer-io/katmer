mod test_support;

use katmer_core::providers::ssh::SshProvider;
use katmer_core::providers::KatmerProvider;

fn require_ssh() -> test_support::SshTestConfig {
    match test_support::ssh_config_from_env() {
        Some(c) => c,
        None => {
            panic!(
                "SSH integration tests require env vars: KATMER_TEST_SSH_HOST, KATMER_TEST_SSH_USER, KATMER_TEST_SSH_PASSWORD (optional: KATMER_TEST_SSH_PORT)"
            );
        }
    }
}

#[tokio::test]
#[ignore]
async fn ssh_provider_connect_and_exec() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password);
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let r = p.execute("uname -s", None).await.unwrap();
    assert_eq!(r.code, 0);
    assert!(!r.stdout.trim().is_empty());
}

#[tokio::test]
#[ignore]
async fn ssh_provider_upload_and_download_roundtrip() {
    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password);
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let dir = test_support::temp_dir("ssh_roundtrip");
    let local_src = dir.join("src.txt");
    let local_dst = dir.join("dst.txt");
    test_support::write_text(&local_src, "hello-ssh");

    let remote_path = format!("/tmp/katmer-core-test-{}.txt", std::process::id());
    p.upload_file(&local_src, &remote_path).await.unwrap();

    let stat = p.execute(&format!("test -f {}", remote_path), None).await.unwrap();
    assert_eq!(stat.code, 0);

    p.download_file(&remote_path, &local_dst).await.unwrap();
    assert_eq!(test_support::read_text(&local_dst), "hello-ssh");

    let _ = p.execute(&format!("rm -f -- {}", remote_path), None).await;
}

#[tokio::test]
#[ignore]
async fn ssh_provider_interactive_sudo_works_when_enabled() {
    if std::env::var("KATMER_TEST_SSH_SUDO").ok().as_deref() != Some("1") {
        return;
    }

    let c = require_ssh();
    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password.clone());
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let mut opts = std::collections::HashMap::new();
    opts.insert("interactivePassword".to_string(), c.password);
    let r = p
        .execute("sudo -S -p 'KATMER_SUDO_PROMPT:' id -u", Some(&opts))
        .await
        .unwrap();
    assert_eq!(r.code, 0);
}
