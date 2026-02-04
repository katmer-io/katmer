use napi_derive::napi;
use std::path::PathBuf;
use tokio::sync::Mutex;

fn anyhow_to_napi(err: anyhow::Error) -> napi::Error {
  napi::Error::from_reason(err.to_string())
}

#[napi]
pub fn sum(a: i32, b: i32) -> i32 {
  crate::sum(a, b)
}

#[napi(object)]
pub struct KatmerCoreOptions {
  pub cwd: Option<String>,
  pub target: Option<Vec<String>>,
}

#[napi(js_name = "NativeKatmerCore")]
pub struct NativeKatmerCore {
  inner: Mutex<crate::KatmerCore>,
}

#[napi]
impl NativeKatmerCore {
  #[napi(constructor)]
  pub fn new(opts: Option<KatmerCoreOptions>) -> napi::Result<Self> {
    let cwd = match opts.as_ref().and_then(|o| o.cwd.as_ref()) {
      Some(p) => PathBuf::from(p),
      None => std::env::current_dir()
        .map_err(|e| napi::Error::from_reason(format!("failed to read current dir: {e}")))?,
    };

    let config_path = opts
      .and_then(|o| o.target)
      .and_then(|t| t.into_iter().next())
      .unwrap_or_default();

    Ok(Self {
      inner: Mutex::new(crate::KatmerCore::new(config_path, cwd)),
    })
  }

  #[napi(js_name = "loadConfig")]
  pub async fn load_config(&self, config_json: Option<String>) -> napi::Result<()> {
    let mut core = self.inner.lock().await;
    match config_json {
      Some(json) => core.load_config_json(&json).map_err(anyhow_to_napi),
      None => core.init().map_err(anyhow_to_napi),
    }
  }

  #[napi]
  pub async fn check(&self) -> napi::Result<()> {
    let mut core = self.inner.lock().await;
    core.check().await.map_err(anyhow_to_napi)
  }

  #[napi]
  pub async fn run(&self, file: String) -> napi::Result<()> {
    let mut core = self.inner.lock().await;
    core.run(&file).await.map_err(anyhow_to_napi)
  }
}
