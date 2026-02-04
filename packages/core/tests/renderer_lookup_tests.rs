mod test_support;

use katmer_core::utils::renderer::Renderer;

#[test]
fn lookup_env_and_default() {
    std::env::set_var("KATMER_LOOKUP_TEST", "ok");

    let vars = serde_json::json!({});
    let mut r = Renderer::new();
    let out = r
        .render("{{ lookup(store=\"env\", key=\"KATMER_LOOKUP_TEST\") }}", &vars)
        .unwrap();
    assert_eq!(out, "ok");

    let out = r
        .render(
            "{{ lookup(store=\"env\", key=\"MISSING___\", default=\"fallback\", error=\"ignore\") }}",
            &vars,
        )
        .unwrap();
    assert_eq!(out, "fallback");
}

#[test]
fn lookup_var_nested() {
    let vars = serde_json::json!({"a": {"b": "c"}});
    let mut r = Renderer::new();
    let out = r
        .render("{{ lookup(store=\"var\", key=\"a.b\") }}", &vars)
        .unwrap();
    assert_eq!(out, "c");
}

#[test]
fn lookup_file_uses_cwd() {
    let dir = test_support::temp_dir("lookup_file");
    let file = dir.join("hello.txt");
    test_support::write_text(&file, "hello-file");

    let vars = serde_json::json!({});
    let mut r = Renderer::new();
    let out = r
        .render_with_cwd(
            "{{ lookup(store=\"file\", path=\"hello.txt\") }}",
            &vars,
            Some(&dir),
        )
        .unwrap();
    assert_eq!(out, "hello-file");
}

#[tokio::test]
async fn lookup_url_fetches_text() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 2048];
        let _ = sock.read(&mut buf).await.unwrap();
        let body = b"hello";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        sock.write_all(resp.as_bytes()).await.unwrap();
        sock.write_all(body).await.unwrap();
        let _ = sock.shutdown().await;
    });

    let url = format!("http://{}:{}/", addr.ip(), addr.port());
    let vars = serde_json::json!({});
    let tpl = format!("{{{{ lookup(store=\"url\", url=\"{}\") }}}}", url);

    let out = tokio::task::spawn_blocking(move || {
        let mut r = Renderer::new();
        r.render(&tpl, &vars).unwrap()
    })
    .await
    .unwrap();
    assert_eq!(out, "hello");

    server.await.unwrap();
}
