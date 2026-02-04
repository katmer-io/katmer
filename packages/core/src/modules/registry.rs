use crate::modules::{
    KatmerModule,
    apt::AptModule,
    apt_repository::AptRepositoryModule,
    copy::CopyModule,
    cron::CronModule,
    debug::DebugModule,
    gather_facts::GatherFactsModule,
    git::GitModule,
    hostname::HostnameModule,
    http::HttpModule,
    package::PackageModule,
    r#become::BecomeModule,
    script::ScriptModule,
    set_fact::SetFactModule,
    shell::ShellModule,
    systemd_service::SystemdServiceModule,
    template::TemplateModule,
    archive::ArchiveModule,
};
use std::collections::HashMap;

pub struct ModuleRegistry {
    modules: HashMap<String, Box<dyn KatmerModule>>,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        let mut modules: HashMap<String, Box<dyn KatmerModule>> = HashMap::new();
        
        modules.insert("apt".to_string(), Box::new(AptModule));
        modules.insert("apt_repository".to_string(), Box::new(AptRepositoryModule));
        modules.insert("archive".to_string(), Box::new(ArchiveModule));
        modules.insert("become".to_string(), Box::new(BecomeModule));
        modules.insert("copy".to_string(), Box::new(CopyModule));
        modules.insert("cron".to_string(), Box::new(CronModule));
        modules.insert("debug".to_string(), Box::new(DebugModule));
        modules.insert("gather_facts".to_string(), Box::new(GatherFactsModule));
        modules.insert("git".to_string(), Box::new(GitModule));
        modules.insert("hostname".to_string(), Box::new(HostnameModule));
        modules.insert("http".to_string(), Box::new(HttpModule));
        modules.insert("package".to_string(), Box::new(PackageModule));
        modules.insert("script".to_string(), Box::new(ScriptModule));
        modules.insert("set_fact".to_string(), Box::new(SetFactModule));
        modules.insert("systemd_service".to_string(), Box::new(SystemdServiceModule));
        modules.insert("template".to_string(), Box::new(TemplateModule));
        modules.insert("shell".to_string(), Box::new(ShellModule));
        
        Self { modules }
    }

    pub fn get(&self, name: &str) -> Option<&dyn KatmerModule> {
        self.modules.get(name).map(|b| b.as_ref())
    }
}
