use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use tracing_appender::rolling;
use crate::config::LoggingConfig;

pub fn setup_logging(config: Option<&LoggingConfig>) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(config.and_then(|c| c.level.as_ref()).map(|s| s.as_str()).unwrap_or("info")));

    let log_format = std::env::var("KATMER_LOG_FORMAT").unwrap_or_else(|_| "text".to_string());

    if log_format == "json" {
        let fmt_layer = fmt::layer()
            .json()
            .with_target(true)
            .with_thread_ids(false)
            .with_file(false)
            .with_line_number(false);
        
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    } else {
        let fmt_layer = fmt::layer()
            .with_target(false)
            .with_thread_ids(false)
            .with_file(false)
            .with_line_number(false);
        
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    }
}
