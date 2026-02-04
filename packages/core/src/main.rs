use clap::{Parser, Subcommand};
use katmer_core::KatmerCore;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "katmer")]
#[command(version, about = "Manage your infrastructure with ease.", long_about = None)]
struct Cli {
    /// Path to config file
    #[arg(short, long)]
    target: Option<String>,

    /// Override working directory
    #[arg(long)]
    cwd: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Execute katmer task file
    Run {
        /// The file to run
        file: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    
    katmer_core::utils::logging::setup_logging(None);

    let cwd = cli.cwd.unwrap_or_else(|| std::env::current_dir().unwrap());
    
    let target = if let Some(t) = cli.target {
        t
    } else {
        let defaults = ["katmer.yaml", "katmer.yml", "katmer.json5", "katmer.json", "katmer.toml"];
        let mut found = "/etc/katmer/config.yaml".to_string();
        for d in defaults {
            if cwd.join(d).exists() {
                found = cwd.join(d).to_string_lossy().to_string();
                break;
            }
        }
        found
    };

    let mut core = KatmerCore::new(target, cwd);
    core.init()?; 

    match &cli.command {
        Some(Commands::Run { file }) => {
            core.run(file).await?;
        }
        None => {
            println!("No command provided. Use --help for usage.");
        }
    }

    Ok(())
}
