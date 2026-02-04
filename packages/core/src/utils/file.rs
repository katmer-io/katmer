use std::path::Path;
use anyhow::{Context, Result};
use std::fs;

// Generic return type could be improved, but deserializing to specific struct immediately is better usually.
// However, the legacy code parses locally first.
pub fn read_katmer_file<P: AsRef<Path>>(path: P) -> Result<serde_json::Value> {
    let path = path.as_ref();
    let content = fs::read_to_string(path).with_context(|| format!("Failed to read file: {:?}", path))?;
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    match extension {
        "yaml" | "yml" => {
            let val: serde_json::Value = serde_yaml::from_str(&content)?;
            Ok(val)
        },
        // Standard JSON
        "json" => {
             Ok(serde_json::from_str(&content)?)
        },
        // JSON5 / JSONC
        "jsonc" | "json5" => {
            let val: serde_json::Value = json5::from_str(&content)?;
            Ok(val)
        },
        "toml" => {
            // toml::Value to serde_json::Value conversion might be needed or just deserialize to struct directly later
            // For now, let's try to parse as toml::Value and convert if possible, or just hack it via string
             let val: toml::Value = toml::from_str(&content)?;
             // Convert to json value via roundtrip or explicit conversion
             // Simplest is serde_json::to_value(val)
             Ok(serde_json::to_value(val)?)
        },
        _ => anyhow::bail!("Unsupported file type: {}", extension),
    }
}
