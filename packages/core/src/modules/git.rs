use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct GitModule;

#[async_trait::async_trait]
impl KatmerModule for GitModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let repo = params.get("repo").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("git: 'repo' is required"))?;
        let dest = params.get("dest").and_then(|v| v.as_str()).ok_or_else(|| anyhow::anyhow!("git: 'dest' is required"))?;
        let version = params.get("version").and_then(|v| v.as_str()).unwrap_or("HEAD");
        let force = params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
        let depth = params.get("depth").and_then(|v| v.as_u64());

        let mut changed = false;

        // 1. Check if .git exists
        let exists_res = ctx.exec(&format!("test -d {}/.git", dest), None).await?;
        let exists = exists_res.code == 0;

        if !exists {
            // Clone
            let depth_arg = if let Some(d) = depth { format!("--depth {}", d) } else { "".to_string() };
            let cmd = format!("git clone {} {} {}", depth_arg, repo, dest);
            let res = ctx.exec(&cmd, None).await?;
            if res.code != 0 {
                anyhow::bail!("git clone failed: {}", res.stderr);
            }
            changed = true;
        }

        // 2. Resolve revision before
        let rev_before_res = ctx.exec(&format!("git -C {} rev-parse HEAD", dest), None).await?;
        let rev_before = rev_before_res.stdout.trim();

        // 3. Update/Checkout
        if force {
            let cmd = format!("git -C {} fetch --all && git -C {} reset --hard {}", dest, dest, version);
            let res = ctx.exec(&cmd, None).await?;
            if res.code != 0 {
                anyhow::bail!("git reset --hard failed: {}", res.stderr);
            }
        } else {
            // Fetch
            let fetch_res = ctx.exec(&format!("git -C {} fetch", dest), None).await?;
            if fetch_res.code != 0 {
                anyhow::bail!("git fetch failed: {}", fetch_res.stderr);
            }
            // Checkout
            let checkout_res = ctx.exec(&format!("git -C {} checkout {}", dest, version), None).await?;
            if checkout_res.code != 0 {
                anyhow::bail!("git checkout failed: {}", checkout_res.stderr);
            }
        }

        // 4. Resolve revision after
        let rev_after_res = ctx.exec(&format!("git -C {} rev-parse HEAD", dest), None).await?;
        let rev_after = rev_after_res.stdout.trim();

        if rev_before != rev_after {
            changed = true;
        }

        Ok(ModuleResponse {
            changed,
            failed: false,
            msg: format!("Git synchronization complete. Revision: {}", rev_after),
            stdout: Some(rev_after.to_string()),
            stderr: None,
        })
    }
}
