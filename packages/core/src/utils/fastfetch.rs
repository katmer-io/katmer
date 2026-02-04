use serde::Deserialize;
use anyhow::{Result, Context};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
pub struct GithubAsset {
    pub name: String,
    pub browser_download_url: String,
}

pub async fn get_latest_release() -> Result<GithubRelease> {
    let client = reqwest::Client::new();
    let url = "https://api.github.com/repos/fastfetch-cli/fastfetch/releases/latest";
    let res = client.get(url)
        .header("User-Agent", "katmer-core")
        .send()
        .await?
        .json::<GithubRelease>()
        .await?;
    Ok(res)
}

pub fn pick_asset(release: &GithubRelease, os: &str, arch: &str) -> Result<GithubAsset> {
    let os_lower = os.to_lowercase();
    let arch_lower = arch.to_lowercase();

    // Mapping for common arch names
    let arch_tokens = match arch_lower.as_str() {
        "x86_64" | "amd64" | "x64" => vec!["x86_64", "amd64", "x64"],
        "aarch64" | "arm64" => vec!["aarch64", "arm64"],
        "armv7" | "armhf" | "arm" => vec!["armv7", "armhf", "arm"],
        _ => vec![arch_lower.as_str()],
    };

    let os_patterns = match os_lower.as_str() {
        "windows" => vec!["windows", "win"],
        "darwin" | "macos" => vec!["macos", "darwin"],
        "linux" => vec!["linux"],
        _ => vec![os_lower.as_str()],
    };

    // Strict match
    for asset in &release.assets {
        let name = asset.name.to_lowercase();
        if !name.ends_with(".zip") { continue; }
        
        let has_os = os_patterns.iter().any(|&p| name.contains(p));
        let has_arch = arch_tokens.iter().any(|&a| name.contains(a));
        
        if has_os && has_arch {
            return Ok(GithubAsset {
                name: asset.name.clone(),
                browser_download_url: asset.browser_download_url.clone(),
            });
        }
    }

    // Loose match (just OS)
    for asset in &release.assets {
        let name = asset.name.to_lowercase();
        if !name.ends_with(".zip") { continue; }
        
        if os_patterns.iter().any(|&p| name.contains(p)) {
            return Ok(GithubAsset {
                name: asset.name.clone(),
                browser_download_url: asset.browser_download_url.clone(),
            });
        }
    }

    anyhow::bail!("Could not find fastfetch asset for {} - {}", os, arch)
}
