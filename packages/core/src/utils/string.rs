pub fn wildcard_match(name: &str, pattern: &str) -> bool {
    if pattern == "*" || pattern == "all" {
        return true;
    }
    
    // very simple wildcard matching (only * at end or start or exact)
    // for a real implementation we might want a crate like `glob`
    if pattern.contains('*') {
        let regex_pattern = pattern.replace(".", "\\.").replace("*", ".*");
        if let Ok(re) = regex::Regex::new(&format!("^{}$", regex_pattern)) {
            return re.is_match(name);
        }
    }
    
    name == pattern
}
