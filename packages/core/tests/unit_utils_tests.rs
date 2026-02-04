mod test_support;

use katmer_core::utils::{file::read_katmer_file, renderer::Renderer, string::wildcard_match};

#[test]
fn wildcard_match_basic() {
    assert!(wildcard_match("a", "a"));
    assert!(wildcard_match("abc", "a*"));
    assert!(wildcard_match("abc", "*c"));
    assert!(wildcard_match("abc", "*"));
    assert!(!wildcard_match("abc", "z*"));
}

#[test]
fn read_katmer_file_parses_yaml_json_toml() {
    let dir = test_support::temp_dir("read_katmer_file");

    let yaml_path = dir.join("cfg.yaml");
    test_support::write_text(&yaml_path, "a: 1\nb: test\n");
    let v = read_katmer_file(&yaml_path).unwrap();
    assert_eq!(v.get("a").and_then(|v| v.as_i64()), Some(1));

    let json_path = dir.join("cfg.json");
    test_support::write_text(&json_path, "{\"a\":2,\"b\":\"ok\"}");
    let v = read_katmer_file(&json_path).unwrap();
    assert_eq!(v.get("a").and_then(|v| v.as_i64()), Some(2));

    let toml_path = dir.join("cfg.toml");
    test_support::write_text(&toml_path, "a = 3\nb = 'toml'\n");
    let v = read_katmer_file(&toml_path).unwrap();
    assert_eq!(v.get("a").and_then(|v| v.as_i64()), Some(3));
}

#[test]
fn renderer_renders_variable() {
    let mut r = Renderer::new();
    let vars = serde_json::json!({"name": "katmer"});
    let out = r.render("hello {{ name }}", &vars).unwrap();
    assert_eq!(out, "hello katmer");
}
