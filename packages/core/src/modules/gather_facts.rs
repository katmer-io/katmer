use crate::modules::{KatmerModule, ModuleResponse};
use anyhow::{Result, Context};
use serde_json::Value;
use crate::task::context::TaskContext;
use std::collections::HashMap;
use crate::utils::fastfetch;

pub struct GatherFactsModule;

#[async_trait::async_trait]
impl KatmerModule for GatherFactsModule {
    async fn execute(&self, ctx: &mut TaskContext<'_>, _params: &Value) -> Result<ModuleResponse> {
        // 1. Get OS info from provider
        let os_info = ctx.provider.get_os_info().await?;

        // 2. Resolve fastfetch release
        let release = fastfetch::get_latest_release().await
            .context("Failed to resolve latest fastfetch release")?;
        
        let asset = fastfetch::pick_asset(&release, &os_info.family, &os_info.arch)
            .context("Failed to pick suitable fastfetch asset")?;

        let tag = &release.tag_name;
        let url = &asset.browser_download_url;

        // 3. Ensure remote binary
        let bin_path = if os_info.family == "windows" {
            self.ensure_remote_windows(ctx, url, tag).await?
        } else {
            self.ensure_remote_posix(ctx, url, tag).await?
        };

        // 4. Run fastfetch
        let ffetch_args = "--format json --structure bios:board:cpu:cpucache:datetime:disk:dns:gpu:host:initsystem:kernel:locale:localip:memory:os:packages:physicaldisk:publicip:shell:swap:terminal:title:tpm:uptime:users:version:wifi";
        let cmd = format!("{} {}", bin_path, ffetch_args);
        
        tracing::debug!(cmd = %cmd, "Running fastfetch");
        
        // Use powershell -Command for windows if needed, but the provider's execute should handle it if shell is set
        let res = ctx.exec(&cmd, None).await?;
        
        if res.code != 0 {
            tracing::error!(stderr = %res.stderr, stdout = %res.stdout, "fastfetch failed");
            anyhow::bail!("fastfetch failed on target: {}", res.stderr);
        }

        tracing::debug!(stdout_len = res.stdout.len(), "fastfetch output received");
        
        let stdout_trimmed = res.stdout.trim();
        if stdout_trimmed.is_empty() {
            anyhow::bail!("fastfetch returned empty output");
        }
        
        // Strip ANSI escape codes (they start with ESC[ which is \x1b[)
        let cleaned = stdout_trimmed
            .lines()
            .map(|line| {
                // Remove ANSI escape sequences
                let mut result = String::new();
                let mut chars = line.chars().peekable();
                while let Some(ch) = chars.next() {
                    if ch == '\x1b' {
                        // Skip escape sequence
                        if chars.peek() == Some(&'[') {
                            chars.next(); // skip '['
                            // Skip until we hit a letter (the command)
                            while let Some(&c) = chars.peek() {
                                chars.next();
                                if c.is_alphabetic() {
                                    break;
                                }
                            }
                        }
                    } else {
                        result.push(ch);
                    }
                }
                result
            })
            .collect::<Vec<_>>()
            .join("\n");
        
        // Find the start of JSON array
        let json_start = cleaned.find("[\n")
            .or_else(|| cleaned.find('['))
            .ok_or_else(|| anyhow::anyhow!("No JSON array found in fastfetch output"))?;
        let json_str = &cleaned[json_start..];
        
        tracing::trace!(json_preview = %json_str.chars().take(500).collect::<String>(), "fastfetch JSON preview");

        let facts_json: Value = serde_json::from_str(json_str)
            .context(format!("Failed to parse fastfetch JSON. First 200 chars: {}", &json_str.chars().take(200).collect::<String>()))?;
        
        // Normalize facts: fastfetch returns a list of {type, result}
        let mut facts_map = HashMap::new();
        if let Some(arr) = facts_json.as_array() {
            for item in arr {
                if let (Some(t), Some(r)) = (item.get("type"), item.get("result")) {
                    facts_map.insert(t.as_str().unwrap_or("").to_lowercase(), r.clone());
                }
            }
        }

        // Add native OS info as well
        facts_map.insert("katmer_os_family".to_string(), Value::String(os_info.family.clone()));
        facts_map.insert("katmer_os_arch".to_string(), Value::String(os_info.arch.clone()));

        // Insert into context variables
        ctx.variables.insert("katmer_facts".to_string(), serde_json::to_value(facts_map.clone())?);
        
        // Provide ansible-compatible aliases
        ctx.variables.insert("ansible_os_family".to_string(), Value::String(os_info.family));
        ctx.variables.insert("ansible_architecture".to_string(), Value::String(os_info.arch));

        Ok(ModuleResponse {
            changed: false,
            failed: false,
            msg: format!("Facts gathered using fastfetch {}", tag),
            stdout: Some(res.stdout),
            stderr: Some(res.stderr),
        })
    }
}

impl GatherFactsModule {
    async fn ensure_remote_posix(&self, ctx: &mut TaskContext<'_>, url: &str, tag: &str) -> Result<String> {
        let script = format!(
            r#"URL='{url}'; TAG='{tag}'; HOME_DIR="${{HOME:-$PWD}}"; T="$HOME_DIR/.katmer/bin"; mkdir -p "$T"; BIN="$T/fastfetch"; VER="$T/fastfetch.version"; [ -x "$BIN" ] && [ -f "$VER" ] && [ "$(cat "$VER")" = "$TAG" ] && {{ echo "KATMER_BIN_PATH:$BIN"; exit 0; }}; TMP="$(mktemp -d)"; ZIP="$TMP/ff.zip"; if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$ZIP" "$URL"; elif command -v wget >/dev/null 2>&1; then wget -qO "$ZIP" "$URL"; else exit 90; fi; if command -v unzip >/dev/null 2>&1; then unzip -o "$ZIP" -d "$TMP" >/dev/null; elif command -v busybox >/dev/null 2>&1; then busybox unzip "$ZIP" -d "$TMP" >/dev/null; else exit 91; fi; F="$(find "$TMP" -type f \( -name fastfetch -o -name fastfetch.exe \) | head -n1)"; [ -z "$F" ] && exit 92; install -D -m 0755 "$F" "$BIN"; printf "%s" "$TAG" > "$VER"; rm -rf "$TMP"; echo "KATMER_BIN_PATH:$BIN""#,
            url = url, tag = tag
        );
        
        let res = ctx.exec(&script, None).await?;
        if res.code != 0 {
            anyhow::bail!("Failed to ensure fastfetch on POSIX target: {}", res.stderr);
        }
        
        for line in res.stdout.lines() {
            if let Some(path) = line.strip_prefix("KATMER_BIN_PATH:") {
                return Ok(path.trim().to_string());
            }
        }
        
        anyhow::bail!("Failed to find binary path in script output")
    }

    async fn ensure_remote_windows(&self, ctx: &mut TaskContext<'_>, url: &str, tag: &str) -> Result<String> {
        let script = format!(
            r#"$ErrorActionPreference='Stop'; $URL = '{url}'; $TAG = '{tag}'; $HOME = $env:USERPROFILE; $T = Join-Path $HOME ".katmer\bin"; $BIN = Join-Path $T "fastfetch.exe"; $VER = Join-Path $T "fastfetch.version"; New-Item -ItemType Directory -Force -Path $T | Out-Null; if ((Test-Path $BIN) -and (Test-Path $VER) -and ((Get-Content $VER -Raw).Trim() -eq $TAG)) {{ Write-Output "KATMER_BIN_PATH:$BIN"; exit 0 }}; $zip = Join-Path $env:TEMP ("ff_" + [guid]::NewGuid().ToString() + ".zip"); Invoke-WebRequest -Uri $URL -OutFile $zip -UseBasicParsing; $tmpDir = Join-Path $env:TEMP ("ff_" + [guid]::NewGuid().ToString()); Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpDir); $ff = Get-ChildItem -Path $tmpDir -Recurse -File -Filter fastfetch.exe | Select-Object -First 1; if (-not $ff) {{ throw "fastfetch.exe not found in zip" }}; New-Item -ItemType Directory -Force -Path $T | Out-Null; Copy-Item -Force $ff.FullName $BIN; Set-Content -Path $VER -Value $TAG -NoNewline; Remove-Item -Recurse -Force $tmpDir; Remove-Item -Force $zip; Write-Output "KATMER_BIN_PATH:$BIN""#,
            url = url, tag = tag
        );
        
        // Windows needs powershell for this
        let mut opts = HashMap::new();
        opts.insert("shell".to_string(), "powershell".to_string());
        
        let res = ctx.exec(&script, Some(&opts)).await?;
        if res.code != 0 {
            anyhow::bail!("Failed to ensure fastfetch on Windows target: {}", res.stderr);
        }

        for line in res.stdout.lines() {
            if let Some(path) = line.strip_prefix("KATMER_BIN_PATH:") {
                return Ok(path.trim().to_string());
            }
        }
        
        anyhow::bail!("Failed to find binary path in script output")
    }
}
