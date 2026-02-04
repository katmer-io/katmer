use katmer_core::config::{Group, HostInput, KatmerConfig, LocalConfig, RootTargets, Targets};
use katmer_core::modules::registry::ModuleRegistry;
use katmer_core::target_resolver::KatmerTargetResolver;
use std::collections::HashMap;

#[test]
fn module_registry_contains_expected_modules() {
    let reg = ModuleRegistry::new();
    for name in [
        "shell",
        "script",
        "copy",
        "template",
        "debug",
        "apt",
        "git",
        "set_fact",
        "hostname",
        "gather_facts",
        "become",
        "archive",
        "cron",
        "http",
        "package",
        "systemd_service",
        "apt-repository",
        "apt_repository",
    ] {
        assert!(reg.get(name).is_some(), "missing module: {name}");
    }
}

#[test]
fn target_resolver_resolves_root_hosts_and_patterns() {
    let mut hosts = HashMap::new();
    hosts.insert("a1".to_string(), HostInput::Local(LocalConfig::default()));
    hosts.insert("a2".to_string(), HostInput::Local(LocalConfig::default()));
    hosts.insert("b1".to_string(), HostInput::Local(LocalConfig::default()));

    let cfg = KatmerConfig {
        cwd: None,
        logging: None,
        targets: Targets::Root(RootTargets {
            hosts,
            settings: None,
            variables: None,
            environment: None,
        }),
    };
    let r = KatmerTargetResolver::new(&cfg);

    let mut all = r.resolve_targets("all");
    all.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].name, "a1");

    let only = r.resolve_targets("a1");
    assert_eq!(only.len(), 1);
    assert_eq!(only[0].name, "a1");

    let mut star1 = r.resolve_targets("*1");
    star1.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(star1.len(), 2);
    assert_eq!(star1[0].name, "a1");
    assert_eq!(star1[1].name, "b1");

    let mut inc_exc = r.resolve_targets("a*:!a2");
    inc_exc.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(inc_exc.len(), 1);
    assert_eq!(inc_exc[0].name, "a1");
}

#[test]
fn target_resolver_resolves_groups() {
    let mut web_hosts = HashMap::new();
    web_hosts.insert("web1".to_string(), HostInput::Local(LocalConfig::default()));
    web_hosts.insert("web2".to_string(), HostInput::Local(LocalConfig::default()));

    let mut db_hosts = HashMap::new();
    db_hosts.insert("db1".to_string(), HostInput::Local(LocalConfig::default()));

    let mut grouped = HashMap::new();
    grouped.insert(
        "web".to_string(),
        Group {
            children: None,
            hosts: Some(web_hosts),
            settings: None,
            variables: None,
            environment: None,
        },
    );
    grouped.insert(
        "db".to_string(),
        Group {
            children: None,
            hosts: Some(db_hosts),
            settings: None,
            variables: None,
            environment: None,
        },
    );

    let cfg = KatmerConfig {
        cwd: None,
        logging: None,
        targets: Targets::Grouped(grouped),
    };
    let r = KatmerTargetResolver::new(&cfg);

    let mut web = r.resolve_targets("web");
    web.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(web.len(), 2);
    assert_eq!(web[0].name, "web1");

    let mut mixed = r.resolve_targets("web,db1");
    mixed.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(mixed.len(), 3);
    assert_eq!(mixed[0].name, "db1");
}
