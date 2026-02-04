use crate::config::{KatmerConfig, KatmerHostResolved, Targets, HostInput, Group, RootTargets};
use crate::utils::string::wildcard_match;
use std::collections::{HashMap, HashSet};
use serde_json::Value;

pub struct KatmerTargetResolver {
    all_names: HashSet<String>,
    groups: HashMap<String, HashSet<String>>,
    hosts: HashMap<String, KatmerHostResolved>,
}

impl KatmerTargetResolver {
    pub fn new(config: &KatmerConfig) -> Self {
        let (groups, hosts, all_names) = Self::normalize_hosts(&config.targets);
        Self {
            all_names,
            groups,
            hosts,
        }
    }

    pub fn resolve_targets(&self, pattern: &str) -> Vec<KatmerHostResolved> {
        if pattern == "all" || pattern == "*" {
            return self.hosts.values().cloned().collect();
        }

        let parts: Vec<&str> = pattern.split(|c| c == ':' || c == ',').collect();
        let mut included = Vec::new();
        let mut excluded = Vec::new();
        let mut intersected = Vec::new();

        for part in parts {
            let part = part.trim();
            if part.is_empty() { continue; }

            if part.starts_with('!') {
                excluded.push(&part[1..]);
            } else if part.starts_with('@') {
                intersected.push(&part[1..]);
            } else {
                let token = if part == "all" { "*" } else { part };
                included.push(token);
            }
        }

        let is_excluded = |name: &str| excluded.iter().any(|p| wildcard_match(name, p));
        let matches_any = |name: &str, list: &[&str]| list.iter().any(|p| wildcard_match(name, p));

        // choose label candidates (hosts or groups), honoring exclusion
        let mut candidate_labels = HashSet::new();
        for name in &self.all_names {
            if is_excluded(name) {
                continue;
            }
            if included.is_empty() || matches_any(name, &included) {
                candidate_labels.insert(name);
            }
        }

        // expand labels to hostnames, honoring exclusion & dedupe
        let mut expanded_hostnames = HashSet::new();
        for label in candidate_labels {
            if let Some(group_hosts) = self.groups.get(label) {
                for host in group_hosts {
                    if !is_excluded(host) {
                        expanded_hostnames.insert(host);
                    }
                }
            } else if self.hosts.contains_key(label) {
                if !is_excluded(label) {
                    expanded_hostnames.insert(label);
                }
            }
        }

        // optional intersection (@foo) applied on final hostnames
        let mut final_hostnames: Vec<&String> = expanded_hostnames.into_iter().collect();
        if !intersected.is_empty() {
            final_hostnames.retain(|h| matches_any(h, &intersected));
        }

        let mut result: Vec<KatmerHostResolved> = final_hostnames
            .iter()
            .filter_map(|h| self.hosts.get(*h))
            .cloned()
            .collect();

        if result.is_empty() && !pattern.is_empty() {
            // TODO: check mode / log warning or return error 
        }

        result
    }

    fn normalize_hosts(targets: &Targets) -> (HashMap<String, HashSet<String>>, HashMap<String, KatmerHostResolved>, HashSet<String>) {
        let mut all_names = HashSet::new();
        let mut hosts = HashMap::new();
        let mut groups: HashMap<String, HashSet<String>> = HashMap::new();

        match targets {
            Targets::Root(root) => {
                Self::process_root(root, &mut all_names, &mut hosts, &mut groups);
            }
            Targets::Grouped(grouped) => {
                let mut group_settings = HashMap::new();
                let mut group_variables = HashMap::new();
                let mut group_env = HashMap::new();

                // First pass: resolve basic groups and hosts
                for (group_name, group_def) in grouped {
                    Self::process_group(
                        group_name,
                        group_def,
                        &mut all_names,
                        &mut hosts,
                        &mut groups,
                        &mut group_settings,
                        &mut group_variables,
                        &mut group_env
                    );
                }

                //  handle children inheritance
                for (group_name, group_def) in grouped {
                    if let Some(children) = &group_def.children {
                        for child_group_name in children.keys() {
                            if let Some(child_hosts) = groups.get(child_group_name).cloned() {
                                let parent_settings = group_settings.get(group_name).cloned().unwrap_or_default();
                                let parent_vars = group_variables.get(group_name).cloned().unwrap_or_default();
                                let parent_env = group_env.get(group_name).cloned().unwrap_or_default();

                                for child_hostname in child_hosts {
                                    if let Some(host_resolved) = hosts.get_mut(&child_hostname) {
                                        // Merge parent settings into connection
                                        host_resolved.connection = Self::merge_host_input(&host_resolved.connection, &parent_settings);
                                        // Merge parent variables and env
                                        host_resolved.variables = Self::merge_maps(&host_resolved.variables, &parent_vars);
                                        host_resolved.environment = Self::merge_string_maps(&host_resolved.environment, &parent_env);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        (groups, hosts, all_names)
    }

    fn process_root(root: &RootTargets, all_names: &mut HashSet<String>, hosts: &mut HashMap<String, KatmerHostResolved>, groups: &mut HashMap<String, HashSet<String>>) {
        let group_name = "ungrouped";
        all_names.insert(group_name.to_string());
        let mut group_hosts = HashSet::new();

        let root_settings = root.settings.clone().unwrap_or_default();
        let root_vars = root.variables.clone().unwrap_or_default();
        let root_env = root.environment.clone().unwrap_or_default();

        for (hostname, input) in &root.hosts {
            all_names.insert(hostname.clone());
            group_hosts.insert(hostname.clone());

            let merged_input = Self::merge_host_input(input, &root_settings);
            
            let mut host_vars = root_vars.clone();
            host_vars.insert("inventory_hostname".to_string(), serde_json::Value::String(hostname.clone()));

            let resolved = KatmerHostResolved {
                name: hostname.clone(),
                connection: merged_input,
                variables: host_vars,
                environment: root_env.clone(),
            };
            hosts.insert(hostname.clone(), resolved);
        }
        groups.insert(group_name.to_string(), group_hosts);
    }

    fn process_group(
        group_name: &str,
        group_def: &Group,
        all_names: &mut HashSet<String>,
        hosts: &mut HashMap<String, KatmerHostResolved>,
        groups: &mut HashMap<String, HashSet<String>>,
        group_settings_accum: &mut HashMap<String, HashMap<String, Value>>,
        group_variables_accum: &mut HashMap<String, HashMap<String, Value>>,
        group_env_accum: &mut HashMap<String, HashMap<String, String>>,
    ) {
        all_names.insert(group_name.to_string());
        groups.entry(group_name.to_string()).or_insert_with(HashSet::new);

        let settings = group_def.settings.clone().unwrap_or_default();
        let variables = group_def.variables.clone().unwrap_or_default();
        let environment = group_def.environment.clone().unwrap_or_default();

        group_settings_accum.insert(group_name.to_string(), settings.clone());
        group_variables_accum.insert(group_name.to_string(), variables.clone());
        group_env_accum.insert(group_name.to_string(), environment.clone());

        if let Some(host_map) = &group_def.hosts {
            let group_hosts = groups.get_mut(group_name).unwrap();
            for (hostname, input) in host_map {
                all_names.insert(hostname.clone());
                group_hosts.insert(hostname.clone());

                let merged_input = Self::merge_host_input(input, &settings);

                let mut host_vars = variables.clone();
                host_vars.insert("inventory_hostname".to_string(), serde_json::Value::String(hostname.clone()));

                let resolved = KatmerHostResolved {
                    name: hostname.clone(),
                    connection: merged_input,
                    variables: host_vars,
                    environment: environment.clone(),
                };
                hosts.insert(hostname.clone(), resolved);
            }
        }
    }

    fn merge_host_input(base: &HostInput, settings: &HashMap<String, Value>) -> HostInput {
        if settings.is_empty() {
            return base.clone();
        }

        let mut base_val = serde_json::to_value(base).unwrap();
        if let Value::Object(ref mut map) = base_val {
            for (k, v) in settings {
                map.insert(k.clone(), v.clone());
            }
        }
        
        serde_json::from_value(base_val).unwrap_or_else(|_| base.clone())
    }

    fn merge_maps(base: &HashMap<String, Value>, incoming: &HashMap<String, Value>) -> HashMap<String, Value> {
        let mut result = base.clone();
        for (k, v) in incoming {
            result.insert(k.clone(), v.clone()); // Shadow base if same key
        }
        result
    }

    fn merge_string_maps(base: &HashMap<String, String>, incoming: &HashMap<String, String>) -> HashMap<String, String> {
        let mut result = base.clone();
        for (k, v) in incoming {
            result.insert(k.clone(), v.clone());
        }
        result
    }
}

