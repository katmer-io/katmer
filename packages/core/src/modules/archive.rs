use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::Result;
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct ArchiveModule;

#[async_trait::async_trait]
impl KatmerModule for ArchiveModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let src = params.get("src").and_then(|v| v.as_str());
        let dest = params.get("dest").and_then(|v| v.as_str());
        let path = params.get("path");
        let chdir = params.get("chdir").and_then(|v| v.as_str());
        let list = params.get("list").and_then(|v| v.as_bool()).unwrap_or(false);
        let verbose = params.get("verbose").and_then(|v| v.as_bool()).unwrap_or(false);
        
        // Compression options
        let gzip = params.get("gzip").and_then(|v| v.as_bool()).unwrap_or(false);
        let bzip2 = params.get("bzip2").and_then(|v| v.as_bool()).unwrap_or(false);
        let xz = params.get("xz").and_then(|v| v.as_bool()).unwrap_or(false);
        let zstd = params.get("zstd").and_then(|v| v.as_bool()).unwrap_or(false);
        
        // Other options
        let strip_components = params.get("strip_components").and_then(|v| v.as_u64()).unwrap_or(0);
        let exclude = params.get("exclude").and_then(|v| v.as_array());
        let preserve_permissions = params.get("preserve_permissions").and_then(|v| v.as_bool()).unwrap_or(false);
        let no_same_owner = params.get("no_same_owner").and_then(|v| v.as_bool()).unwrap_or(false);
        let no_same_permissions = params.get("no_same_permissions").and_then(|v| v.as_bool()).unwrap_or(false);
        let numeric_owner = params.get("numeric_owner").and_then(|v| v.as_bool()).unwrap_or(false);
        let uid = params.get("uid").and_then(|v| v.as_u64());
        let gid = params.get("gid").and_then(|v| v.as_u64());
        let options = params.get("options").and_then(|v| v.as_array());

        // Validate parameters
        if src.is_none() && path.is_none() {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "archive: one of 'src' or 'path' is required".to_string(),
                stdout: None,
                stderr: None,
            });
        }

        if dest.is_none() && !list && options.is_none() {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "archive: 'dest' is required unless listing or raw options".to_string(),
                stdout: None,
                stderr: None,
            });
        }

        // Detect tar binary
        let tar_cmd = match detect_tar(ctx).await {
            Ok(cmd) => cmd,
            Err(e) => {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: format!("archive: {}", e),
                    stdout: None,
                    stderr: None,
                });
            }
        };

        // Build arguments
        let mut args = Vec::new();

        // Determine mode
        if list {
            args.push("-t".to_string());
        } else if src.is_some() {
            args.push("-x".to_string());
        } else {
            args.push("-c".to_string());
        }

        // Verbose
        if verbose {
            args.push("-v".to_string());
        }

        // Compression
        if gzip {
            args.push("--gzip".to_string());
        }
        if bzip2 {
            args.push("--bzip2".to_string());
        }
        if xz {
            args.push("--xz".to_string());
        }
        if zstd {
            args.push("--zstd".to_string());
        }

        // Archive file
        let archive_arg = src.or(dest);
        if let Some(archive) = archive_arg {
            args.push("-f".to_string());
            args.push(format!("\"{}\"", archive));
        }

        // Directory change before action
        if let Some(dir) = chdir {
            args.push("-C".to_string());
            args.push(format!("\"{}\"", dir));
        }

        // Creation paths
        if let Some(p) = path {
            if src.is_none() {
                if let Some(path_str) = p.as_str() {
                    args.push(format!("\"{}\"", path_str));
                } else if let Some(path_array) = p.as_array() {
                    for item in path_array {
                        if let Some(path_str) = item.as_str() {
                            args.push(format!("\"{}\"", path_str));
                        }
                    }
                }
            }
        }

        // Strip components
        if strip_components > 0 {
            args.push(format!("--strip-components={}", strip_components));
        }

        // Exclude patterns
        if let Some(exclude_array) = exclude {
            for item in exclude_array {
                if let Some(exclude_str) = item.as_str() {
                    args.push(format!("--exclude=\"{}\"", exclude_str));
                }
            }
        }

        // Ownership/Permission
        if numeric_owner {
            args.push("--numeric-owner".to_string());
        }
        if let Some(uid_val) = uid {
            args.push(format!("--uid={}", uid_val));
        }
        if let Some(gid_val) = gid {
            args.push(format!("--gid={}", gid_val));
        }

        if preserve_permissions {
            args.push("--preserve-permissions".to_string());
        }
        if no_same_owner {
            args.push("--no-same-owner".to_string());
        }
        if no_same_permissions {
            args.push("--no-same-permissions".to_string());
        }

        // Raw extra options
        if let Some(opts_array) = options {
            for item in opts_array {
                if let Some(opt_str) = item.as_str() {
                    args.push(opt_str.to_string());
                }
            }
        }

        // Final command
        let cmd = format!("{} {}", tar_cmd, args.join(" "));

        let res = ctx.exec(&cmd, None).await?;

        Ok(ModuleResponse {
            changed: !list,
            failed: res.code != 0,
            msg: "Archive operation completed".to_string(),
            stdout: Some(res.stdout),
            stderr: Some(res.stderr),
        })
    }
}

async fn detect_tar(ctx: &TaskContext<'_>) -> Result<String> {
    // Try tar first (works on most systems), then tar.exe (Windows)
    let binaries = ["tar", "tar.exe"];
    
    for binary in &binaries {
        let cmd = format!("{} --version", binary);
        if let Ok(_) = ctx.exec(&cmd, None).await {
            return Ok(binary.to_string());
        }
    }
    
    Err(anyhow::anyhow!("neither bsdtar nor tar was found on target"))
}