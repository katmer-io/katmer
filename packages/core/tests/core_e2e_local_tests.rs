mod test_support;

use katmer_core::KatmerCore;
use katmer_core::utils::file::read_katmer_file;

fn yq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[tokio::test]
async fn core_runs_task_file_on_local_target() {
    let dir = test_support::temp_dir("core_e2e_local");
    let cfg_path = dir.join("katmer.yaml");
    let tasks_path = dir.join("tasks.yaml");
    let template_src = dir.join("hello.tmpl");
    let copy_dest = dir.join("copied.txt");
    let template_dest = dir.join("rendered.txt");

    test_support::write_text(&template_src, "hello {{ inventory_hostname }}\n");

    let cfg = test_support::local_config_yaml("local", None);
    test_support::write_text(&cfg_path, &cfg);

    let copy_dest_s = copy_dest.to_string_lossy().to_string();
    let template_src_s = template_src.to_string_lossy().to_string();
    let template_dest_s = template_dest.to_string_lossy().to_string();

    let tasks = format!(
        "tasks:\n  - name: copy file\n    targets: [\"local\"]\n    copy:\n      dest: {}\n      content: \"hello\"\n  - name: render template\n    targets: [\"local\"]\n    template:\n      src: {}\n      dest: {}\n",
        yq(&copy_dest_s),
        yq(&template_src_s),
        yq(&template_dest_s),
    );

    if let Err(e) = serde_yaml::from_str::<serde_json::Value>(&tasks) {
        panic!("generated tasks.yaml is invalid: {}\n{}", e, tasks);
    }
    test_support::write_text(&tasks_path, &tasks);

    let read_back = test_support::read_text(&tasks_path);
    if let Err(e) = serde_yaml::from_str::<serde_json::Value>(&read_back) {
        panic!("tasks.yaml on disk is invalid: {}\n{}", e, read_back);
    }

    read_katmer_file(&tasks_path).unwrap();

    let mut core = KatmerCore::new(cfg_path.to_string_lossy().to_string(), dir.clone());
    core.init().unwrap();
    let tasks_path_s = tasks_path.to_string_lossy().to_string();
    if let Err(e) = core.run(&tasks_path_s).await {
        panic!("core.run failed: {:#}", e);
    }

    assert_eq!(test_support::read_text(&copy_dest), "hello");
    assert_eq!(test_support::read_text(&template_dest), "hello local\n");
}
