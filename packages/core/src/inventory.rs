use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::config::KatmerHostResolved;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostState {
    pub resolved: KatmerHostResolved,
    pub variables: HashMap<String, serde_json::Value>,
}

pub struct Inventory {
    pub hosts: HashMap<String, HostState>,
}

impl Inventory {
    pub fn new(resolved_hosts: Vec<KatmerHostResolved>) -> Self {
        let mut hosts = HashMap::new();
        for host in resolved_hosts {
            hosts.insert(host.name.clone(), HostState {
                variables: host.variables.clone(),
                resolved: host,
            });
        }
        Self { hosts }
    }

    pub fn get_host(&self, name: &str) -> Option<&HostState> {
        self.hosts.get(name)
    }

    pub fn update_variables(&mut self, name: &str, vars: HashMap<String, serde_json::Value>) {
        if let Some(host) = self.hosts.get_mut(name) {
            for (k, v) in vars {
                if k == "interactivePassword" || k == "become_password" {
                    continue;
                }
                host.variables.insert(k, v);
            }
        }
    }
}
