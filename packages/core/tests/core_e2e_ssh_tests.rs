mod test_support;

use katmer_core::KatmerCore;
use katmer_core::providers::ssh::SshProvider;
use katmer_core::providers::KatmerProvider;

#[tokio::test]
#[ignore]
async fn core_runs_task_file_on_ssh_target() {
    let c = test_support::ssh_config_from_env().expect(
        "set KATMER_TEST_SSH_HOST, KATMER_TEST_SSH_USER, KATMER_TEST_SSH_PASSWORD (optional: KATMER_TEST_SSH_PORT)",
    );

    let dir = test_support::temp_dir("core_e2e_ssh");
    let cfg_path = dir.join("katmer.yaml");
    let tasks_path = dir.join("tasks.yaml");
    let template_src = dir.join("hello.tmpl");

    test_support::write_text(&template_src, "hello {{ inventory_hostname }}\n");

    let cfg = format!(
        "targets:\n  hosts:\n    debian:\n      connection: ssh\n      hostname: {}\n      port: {}\n      username: {}\n      password: {}\n  variables:\n    shell: \"bash\"\n",
        serde_json::to_string(&c.host).unwrap(),
        c.port,
        serde_json::to_string(&c.user).unwrap(),
        serde_json::to_string(&c.password).unwrap(),
    );
    test_support::write_text(&cfg_path, &cfg);

    let remote_copy = "/tmp/katmer-core-e2e-copy.txt";
    let remote_tmpl = "/tmp/katmer-core-e2e-template.txt";
    let tasks = format!(
        "tasks:\n  - name: copy\n    targets: [\"debian\"]\n    copy:\n      dest: {}\n      content: \"hello\"\n  - name: template\n    targets: [\"debian\"]\n    template:\n      src: {}\n      dest: {}\n",
        serde_json::to_string(remote_copy).unwrap(),
        serde_json::to_string(&template_src.to_string_lossy().to_string()).unwrap(),
        serde_json::to_string(remote_tmpl).unwrap(),
    );
    test_support::write_text(&tasks_path, &tasks);

    let mut core = KatmerCore::new(cfg_path.to_string_lossy().to_string(), dir.clone());
    core.init().unwrap();
    core.run(&tasks_path.to_string_lossy()).await.unwrap();

    let mut p = SshProvider::new(c.host, c.port, c.user).with_password(c.password);
    p.initialize().await.unwrap();
    p.connect().await.unwrap();

    let r1 = p.execute(&format!("cat {}", remote_copy), None).await.unwrap();
    assert_eq!(r1.code, 0);
    assert_eq!(r1.stdout, "hello");

    let r2 = p.execute(&format!("cat {}", remote_tmpl), None).await.unwrap();
    assert_eq!(r2.code, 0);
    assert_eq!(r2.stdout, "hello debian\n");

    let _ = p.execute(&format!("rm -f -- {} {}", remote_copy, remote_tmpl), None).await;
}
