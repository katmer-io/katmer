use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct HttpModule;

fn dq(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

#[async_trait::async_trait]
impl KatmerModule for HttpModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let url = match params.get("url").and_then(|v| v.as_str()) {
            Some(u) if !u.trim().is_empty() => u,
            _ => {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: "http: 'url' is required".to_string(),
                    stdout: None,
                    stderr: None,
                });
            }
        };

        let method = params.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
        let timeout = params.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30);
        let follow_redirects = params.get("follow_redirects").and_then(|v| v.as_bool()).unwrap_or(true);
        let validate_certs = params.get("validate_certs").and_then(|v| v.as_bool()).unwrap_or(true);
        let fail_on_http_error = params.get("fail_on_http_error").and_then(|v| v.as_bool()).unwrap_or(true);

        let mut args: Vec<String> = Vec::new();
        args.push("-sS".to_string());
        if follow_redirects {
            args.push("-L".to_string());
        }
        if !validate_certs {
            args.push("--insecure".to_string());
        }
        if timeout > 0 {
            args.push(format!("--max-time {}", timeout));
        }
        if fail_on_http_error {
            args.push("--fail-with-body".to_string());
        }

        if let Some(retry) = params.get("retry") {
            if let Some(tries) = retry.get("tries").and_then(|v| v.as_u64()) {
                args.push(format!("--retry {}", tries));
            }
            if let Some(delay) = retry.get("delay").and_then(|v| v.as_u64()) {
                args.push(format!("--retry-delay {}", delay));
            }
            if let Some(max_time) = retry.get("max_time").and_then(|v| v.as_u64()) {
                args.push(format!("--retry-max-time {}", max_time));
            }
        }

        if let Some(save_headers_to) = params.get("save_headers_to").and_then(|v| v.as_str()) {
            args.push("-D".to_string());
            args.push(dq(save_headers_to));
        }

        let mut header_args: Vec<String> = Vec::new();
        if let Some(headers) = params.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in headers {
                if let Some(vs) = v.as_str() {
                    header_args.push("-H".to_string());
                    header_args.push(dq(&format!("{}: {}", k, vs)));
                }
            }
        }

        if let Some(auth) = params.get("auth").and_then(|v| v.as_object()) {
            let auth_type = auth.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if auth_type == "basic" {
                let username = auth.get("username").and_then(|v| v.as_str()).unwrap_or("");
                let password = auth.get("password").and_then(|v| v.as_str()).unwrap_or("");
                args.push("-u".to_string());
                args.push(dq(&format!("{}:{}", username, password)));
            } else if auth_type == "bearer" {
                let token = auth.get("token").and_then(|v| v.as_str()).unwrap_or("");
                header_args.push("-H".to_string());
                header_args.push(dq(&format!("Authorization: Bearer {}", token)));
            }
        }

        let mut data_arg: Option<String> = None;
        let mut inferred_json = false;
        if let Some(body_file) = params.get("bodyFile").and_then(|v| v.as_str()) {
            data_arg = Some(format!("--data-binary @{}", dq(body_file)));
        } else if let Some(body) = params.get("body") {
            if let Some(s) = body.as_str() {
                data_arg = Some(format!("--data-binary {}", dq(s)));
            } else if body.is_object() || body.is_array() {
                let json = serde_json::to_string(body).unwrap_or_else(|_| "null".to_string());
                data_arg = Some(format!("--data-binary {}", dq(&json)));
                inferred_json = true;
            }
        }
        if inferred_json {
            let mut has_ct = false;
            if let Some(headers) = params.get("headers").and_then(|v| v.as_object()) {
                for (k, _v) in headers {
                    if k.eq_ignore_ascii_case("content-type") {
                        has_ct = true;
                        break;
                    }
                }
            }
            if !has_ct {
                header_args.push("-H".to_string());
                header_args.push(dq("Content-Type: application/json"));
            }
        }

        let query_items = params.get("query").and_then(|v| v.as_object());
        if let Some(q) = query_items {
            args.push("--get".to_string());
            for (k, v) in q {
                if v.is_null() {
                    continue;
                }
                let value_str = if let Some(s) = v.as_str() {
                    s.to_string()
                } else {
                    v.to_string()
                };
                args.push("--data-urlencode".to_string());
                args.push(dq(&format!("{}={}", k, value_str)));
            }
        }

        let output = params.get("output");
        let mut to_file: Option<String> = None;
        if let Some(o) = output {
            if let Some(s) = o.as_str() {
                to_file = Some(s.to_string());
            } else if let Some(obj) = o.as_object() {
                if let Some(path) = obj.get("toFile").and_then(|v| v.as_str()) {
                    to_file = Some(path.to_string());
                }
            }
        }
        if let Some(dest) = &to_file {
            args.push("-o".to_string());
            args.push(dq(dest));
        }

        let method_arg = if method == "GET" && data_arg.is_none() {
            None
        } else if method == "HEAD" && to_file.is_none() {
            Some("-I".to_string())
        } else if method == "HEAD" {
            Some("-X HEAD".to_string())
        } else {
            Some(format!("-X {}", method))
        };

        let mut cmd_parts: Vec<String> = Vec::new();
        cmd_parts.push("curl".to_string());
        cmd_parts.extend(args);
        if let Some(m) = method_arg {
            cmd_parts.push(m);
        }
        cmd_parts.extend(header_args);
        if let Some(d) = data_arg {
            cmd_parts.push(d);
        }
        cmd_parts.push(dq(url));

        let cmd = cmd_parts.join(" ");
        let res = ctx.exec(&cmd, None).await?;

        Ok(ModuleResponse {
            changed: to_file.is_some() && res.code == 0,
            failed: res.code != 0,
            msg: if res.code == 0 { "http request completed".to_string() } else { "http request failed".to_string() },
            stdout: Some(res.stdout),
            stderr: Some(res.stderr),
        })
    }
}
