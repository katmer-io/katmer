use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::{Context, Result};
use serde_json::Value;
use crate::task::context::TaskContext;

pub struct PackageModule;

#[derive(Debug, Clone, Copy)]
enum PackageManager {
    Apt,
    Dnf,
    Yum,
    Pacman,
    Apk,
    Zypper,
    Brew,
    Winget,
    Choco,
}

impl PackageManager {
    fn as_str(&self) -> &'static str {
        match self {
            PackageManager::Apt => "apt",
            PackageManager::Dnf => "dnf",
            PackageManager::Yum => "yum",
            PackageManager::Pacman => "pacman",
            PackageManager::Apk => "apk",
            PackageManager::Zypper => "zypper",
            PackageManager::Brew => "brew",
            PackageManager::Winget => "winget",
            PackageManager::Choco => "choco",
        }
    }
}

fn names_from_params(params: &Value) -> Option<Vec<String>> {
    if let Some(s) = params.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(vec![trimmed.to_string()])
        }
    } else if let Some(n) = params.get("name") {
        if let Some(s) = n.as_str() {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(vec![trimmed.to_string()])
            }
        } else if let Some(arr) = n.as_array() {
            let mut out = Vec::new();
            for v in arr {
                if let Some(s) = v.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        out.push(trimmed.to_string());
                    }
                }
            }
            if out.is_empty() { None } else { Some(out) }
        } else {
            None
        }
    } else {
        None
    }
}

fn build_command(pm: PackageManager, state: &str, pkgs: &[String]) -> Option<String> {
    let list = pkgs.join(" ");
    match pm {
        PackageManager::Apt => {
            if state == "present" {
                Some(format!("sudo apt-get update -y && sudo apt-get install -y {}", list))
            } else if state == "latest" {
                Some(format!("sudo apt-get update -y && sudo apt-get install -y --only-upgrade {}", list))
            } else if state == "absent" {
                Some(format!("sudo apt-get remove -y {}", list))
            } else {
                None
            }
        }
        PackageManager::Dnf => {
            if state == "absent" {
                Some(format!("sudo dnf remove -y {}", list))
            } else if state == "latest" {
                Some(format!("sudo dnf upgrade -y {}", list))
            } else if state == "present" {
                Some(format!("sudo dnf install -y {}", list))
            } else {
                None
            }
        }
        PackageManager::Yum => {
            if state == "absent" {
                Some(format!("sudo yum remove -y {}", list))
            } else if state == "latest" {
                Some(format!("sudo yum update -y {}", list))
            } else if state == "present" {
                Some(format!("sudo yum install -y {}", list))
            } else {
                None
            }
        }
        PackageManager::Pacman => {
            if state == "absent" {
                Some(format!("sudo pacman -R --noconfirm {}", list))
            } else if state == "present" || state == "latest" {
                Some(format!("sudo pacman -S --noconfirm {}", list))
            } else {
                None
            }
        }
        PackageManager::Apk => {
            if state == "absent" {
                Some(format!("sudo apk del {}", list))
            } else if state == "present" || state == "latest" {
                Some(format!("sudo apk add {}", list))
            } else {
                None
            }
        }
        PackageManager::Zypper => {
            if state == "absent" {
                Some(format!("sudo zypper remove -y {}", list))
            } else if state == "present" || state == "latest" {
                Some(format!("sudo zypper install -y {}", list))
            } else {
                None
            }
        }
        PackageManager::Brew => {
            if state == "absent" {
                Some(format!("brew uninstall {}", list))
            } else if state == "latest" {
                Some(format!("brew upgrade {}", list))
            } else if state == "present" {
                Some(format!("brew install {}", list))
            } else {
                None
            }
        }
        PackageManager::Winget => {
            let mut cmds = Vec::new();
            for pkg in pkgs {
                let c = if state == "absent" {
                    format!("winget uninstall --silent --accept-source-agreements {}", pkg)
                } else if state == "latest" {
                    format!("winget upgrade --silent --accept-source-agreements --accept-package-agreements {}", pkg)
                } else if state == "present" {
                    format!("winget install --silent --accept-source-agreements --accept-package-agreements {}", pkg)
                } else {
                    return None;
                };
                cmds.push(c);
            }
            Some(cmds.join(" && "))
        }
        PackageManager::Choco => {
            if state == "absent" {
                Some(format!("choco uninstall -y {}", list))
            } else if state == "latest" {
                Some(format!("choco upgrade -y {}", list))
            } else if state == "present" {
                Some(format!("choco install -y {}", list))
            } else {
                None
            }
        }
    }
}

async fn detect_package_manager(ctx: &TaskContext<'_>) -> Result<Option<PackageManager>> {
    let os = ctx.provider.get_os_info().await.context("failed to get os info")?;

    let mut probes: Vec<(PackageManager, &str)> = Vec::new();
    if os.family == "linux" {
        probes.extend([
            (PackageManager::Apt, "command -v apt-get"),
            (PackageManager::Dnf, "command -v dnf"),
            (PackageManager::Yum, "command -v yum"),
            (PackageManager::Pacman, "command -v pacman"),
            (PackageManager::Apk, "command -v apk"),
            (PackageManager::Zypper, "command -v zypper"),
        ]);
    } else if os.family == "darwin" {
        probes.push((PackageManager::Brew, "command -v brew"));
    } else if os.family == "windows" {
        probes.extend([
            (PackageManager::Winget, "where winget"),
            (PackageManager::Choco, "where choco"),
        ]);
    }

    for (pm, probe) in probes {
        let r = ctx.exec(probe, None).await?;
        if r.code == 0 {
            return Ok(Some(pm));
        }
    }
    Ok(None)
}

#[async_trait::async_trait]
impl KatmerModule for PackageModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, params: &Value) -> Result<ModuleResponse> {
        let state = params.get("state").and_then(|v| v.as_str()).unwrap_or("present");
        let names = match names_from_params(params) {
            Some(n) => n,
            None => {
                return Ok(ModuleResponse {
                    changed: false,
                    failed: true,
                    msg: "package: 'name' is required".to_string(),
                    stdout: None,
                    stderr: None,
                });
            }
        };

        let pm = detect_package_manager(ctx).await?;
        let Some(pm) = pm else {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: "package: no supported package manager detected on target".to_string(),
                stdout: None,
                stderr: None,
            });
        };

        let Some(cmd) = build_command(pm, state, &names) else {
            return Ok(ModuleResponse {
                changed: false,
                failed: true,
                msg: format!("package: unsupported operation for package manager: {}", pm.as_str()),
                stdout: None,
                stderr: None,
            });
        };

        let r = ctx.exec(&cmd, None).await?;

        Ok(ModuleResponse {
            changed: r.code == 0,
            failed: r.code != 0,
            msg: format!("package manager: {}", pm.as_str()),
            stdout: Some(r.stdout),
            stderr: Some(r.stderr),
        })
    }
}
