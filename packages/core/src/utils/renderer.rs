use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tera::{Context, Function as TeraFunction, Tera, Value};
use std::future::Future;

pub struct Renderer {
    cwd: Option<PathBuf>,
}

impl Renderer {
    pub fn new() -> Self {
        Self { cwd: None }
    }

    pub fn with_cwd(mut self, cwd: Option<PathBuf>) -> Self {
        self.cwd = cwd;
        self
    }

    pub fn render(&mut self, template: &str, variables: &serde_json::Value) -> Result<String> {
        self.render_with_cwd(template, variables, None)
    }

    pub fn render_with_cwd(
        &mut self,
        template: &str,
        variables: &serde_json::Value,
        cwd: Option<&Path>,
    ) -> Result<String> {
        let mut tera = Tera::default();

        let effective_cwd = cwd.map(|p| p.to_path_buf()).or_else(|| self.cwd.clone());
        tera.register_function(
            "lookup",
            LookupFn {
                variables: variables.clone(),
                cwd: effective_cwd,
            },
        );

        let mut context = Context::new();
        if let Some(obj) = variables.as_object() {
            for (k, v) in obj {
                context.insert(k, v);
            }
        }

        Ok(tera.render_str(template, &context)?)
    }
}

#[derive(Clone)]
struct LookupFn {
    variables: serde_json::Value,
    cwd: Option<PathBuf>,
}

fn get_value_at_path<'a>(mut cur: &'a serde_json::Value, parts: &[String]) -> Option<&'a serde_json::Value> {
    for part in parts {
        match cur {
            serde_json::Value::Object(map) => {
                cur = map.get(part)?;
            }
            serde_json::Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                cur = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(cur)
}

fn coerce_parts(v: &serde_json::Value) -> tera::Result<Vec<String>> {
    if let Some(s) = v.as_str() {
        if s.is_empty() {
            return Ok(Vec::new());
        }
        return Ok(s.split('.').map(|p| p.to_string()).collect());
    }
    if let Some(arr) = v.as_array() {
        let mut out = Vec::new();
        for item in arr {
            if let Some(s) = item.as_str() {
                if !s.is_empty() {
                    out.push(s.to_string());
                }
            } else {
                return Err(tera::Error::msg("lookup: keys must be strings"));
            }
        }
        return Ok(out);
    }
    Err(tera::Error::msg("lookup: keys must be string or array"))
}

fn as_string(v: &serde_json::Value) -> tera::Result<String> {
    v.as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| tera::Error::msg("lookup: expected string"))
}

impl TeraFunction for LookupFn {
    fn call(&self, args: &HashMap<String, Value>) -> tera::Result<Value> {
        let store = args
            .get("store")
            .map(as_string)
            .ok_or_else(|| tera::Error::msg("lookup: missing 'store'"))??;

        let default_value = args.get("default").cloned().unwrap_or(serde_json::Value::Null);
        let error_mode = args
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("raise");

        let parts = if let Some(v) = args.get("keys") {
            coerce_parts(v)?
        } else if let Some(v) = args.get("key") {
            coerce_parts(v)?
        } else if let Some(v) = args.get("path") {
            // for file store convenience
            if let Some(s) = v.as_str() {
                vec![s.to_string()]
            } else {
                coerce_parts(v)?
            }
        } else if let Some(v) = args.get("url") {
            if let Some(s) = v.as_str() {
                vec![s.to_string()]
            } else {
                coerce_parts(v)?
            }
        } else {
            Vec::new()
        };

        let result = match store.as_str() {
            "env" => {
                if parts.len() != 1 {
                    Ok(serde_json::Value::Null)
                } else {
                    match std::env::var(&parts[0]) {
                        Ok(v) => Ok(serde_json::Value::String(v)),
                        Err(_) => Ok(serde_json::Value::Null),
                    }
                }
            }
            "var" => {
                if parts.is_empty() {
                    Ok(serde_json::Value::Null)
                } else {
                    Ok(get_value_at_path(&self.variables, &parts)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null))
                }
            }
            "file" => {
                let cwd = if let Some(v) = args.get("cwd") {
                    Some(PathBuf::from(as_string(v)?))
                } else {
                    self.cwd.clone()
                };

                let mut path = cwd.unwrap_or_else(|| PathBuf::from(""));
                for p in &parts {
                    path = path.join(p);
                }

                let encoding = args
                    .get("encoding")
                    .and_then(|v| v.as_str())
                    .unwrap_or("utf-8")
                    .to_lowercase();

                if encoding != "utf-8" && encoding != "utf8" {
                    return Err(tera::Error::msg("lookup(file): only utf-8 is supported"));
                }

                std::fs::read_to_string(&path)
                    .map(|s| serde_json::Value::String(s))
                    .map_err(|e| tera::Error::msg(format!("lookup(file): failed to read {}: {}", path.display(), e)))
            }
            "url" => {
                let url = if parts.is_empty() {
                    return Err(tera::Error::msg("lookup(url): missing url"));
                } else if parts.len() == 1 {
                    parts[0].clone()
                } else {
                    parts.join("/")
                };

                let method = args
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GET")
                    .to_string();

                let timeout_secs = args
                    .get("timeout")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(30);

                let method_parsed = method
                    .parse::<reqwest::Method>()
                    .map_err(|_| tera::Error::msg("lookup(url): invalid method"))?;

                let headers_kv: Vec<(String, String)> = args
                    .get("headers")
                    .and_then(|v| v.as_object())
                    .map(|h| {
                        h.iter()
                            .filter_map(|(k, v)| v.as_str().map(|vs| (k.clone(), vs.to_string())))
                            .collect()
                    })
                    .unwrap_or_default();

                let body_opt: Option<String> = args.get("body").map(|b| {
                    b.as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| b.to_string())
                });

                fn run_future<T, F>(make_fut: impl Fn() -> F + Send + Sync + 'static) -> tera::Result<T>
                where
                    T: Send + 'static,
                    F: Future<Output = tera::Result<T>> + Send + 'static,
                {
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread {
                            tokio::task::block_in_place(|| handle.block_on(make_fut()))
                        } else {
                            std::thread::spawn(move || {
                                let rt = tokio::runtime::Runtime::new().map_err(|e| {
                                    tera::Error::msg(format!("lookup(url): failed to create runtime: {}", e))
                                })?;
                                rt.block_on(make_fut())
                            })
                            .join()
                            .map_err(|_| tera::Error::msg("lookup(url): thread join failed"))?
                        }
                    } else {
                        let rt = tokio::runtime::Runtime::new()
                            .map_err(|e| tera::Error::msg(format!("lookup(url): failed to create runtime: {}", e)))?;
                        rt.block_on(make_fut())
                    }
                }

                let url0 = url.clone();
                let method0 = method_parsed.clone();
                let headers0 = headers_kv.clone();
                let body0 = body_opt.clone();
                let make_fut = move || {
                    let url2 = url0.clone();
                    let method2 = method0.clone();
                    let headers2 = headers0.clone();
                    let body2 = body0.clone();
                    async move {
                        let client = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(timeout_secs))
                            .build()
                            .map_err(|e| tera::Error::msg(format!("lookup(url): failed to build client: {}", e)))?;

                        let mut req = client.request(method2, &url2);

                        if !headers2.is_empty() {
                            let mut headers = reqwest::header::HeaderMap::new();
                            for (k, v) in headers2 {
                                let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
                                    .map_err(|_| tera::Error::msg("lookup(url): invalid header name"))?;
                                let val = reqwest::header::HeaderValue::from_str(&v)
                                    .map_err(|_| tera::Error::msg("lookup(url): invalid header value"))?;
                                headers.insert(name, val);
                            }
                            req = req.headers(headers);
                        }

                        if let Some(body) = body2 {
                            req = req.body(body);
                        }

                        let resp = req
                            .send()
                            .await
                            .map_err(|e| tera::Error::msg(format!("lookup(url): request failed: {}", e)))?;

                        let status = resp.status();
                        let text = resp
                            .text()
                            .await
                            .map_err(|e| tera::Error::msg(format!("lookup(url): failed reading body: {}", e)))?;

                        if status.is_success() {
                            Ok(serde_json::Value::String(text))
                        } else {
                            Err(tera::Error::msg(format!(
                                "lookup(url): failed to fetch url: {} status: {} response: {}",
                                url2,
                                status.as_u16(),
                                text
                            )))
                        }
                    }
                };

                run_future(make_fut)
            }
            _ => Err(tera::Error::msg(format!("lookup: unknown store: {}", store))),
        };

        match result {
            Ok(v) => {
                if v.is_null() {
                    Ok(default_value)
                } else {
                    Ok(v)
                }
            }
            Err(e) => match error_mode {
                "ignore" => Ok(default_value),
                "warn" => {
                    tracing::warn!("lookup to {} failed: {}", store, e);
                    Ok(default_value)
                }
                _ => Err(e),
            },
        }
    }
}
