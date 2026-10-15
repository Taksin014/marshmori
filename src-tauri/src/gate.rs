// Would Claude Code stop and ask before this tool call?
//
// In a terminal Claude Code asks through its PermissionRequest hook, and the island
// answers there. Two places never fire that hook: the panels of the IDE extensions
// (VS Code, Cursor, Windsurf… and the Claude desktop app), and `claude -p`, which
// Mamori's background tasks run and where nobody could answer a prompt anyway. For
// those the island asks one step earlier, at PreToolUse, and answers with
// `permissionDecision` — but only for a call Claude Code would have asked about
// itself, so an `ls` or a Read never turns into a card.
//
// The guess errs safely both ways: one card too many is one more click; one too few
// and the IDE shows its own prompt, exactly as it did before Marshmori.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agents::{Agent, Event};

/// Claude Code front ends whose own permission prompt doesn't fire PermissionRequest.
pub fn is_ide(entry: &str) -> bool {
    let e = entry.to_ascii_lowercase();
    matches!(e.as_str(), "claude-vscode" | "claude-desktop" | "local-agent")
        || e.contains("vscode")
        || e.contains("jetbrains")
        || e.contains("cursor")
        || e.contains("windsurf")
}

/// What to call the agent's own prompt on "answer there instead".
pub fn surface_label(entry: &str) -> &'static str {
    let e = entry.to_ascii_lowercase();
    if e.contains("vscode") || e.contains("cursor") || e.contains("windsurf") {
        "VS Code"
    } else if e.contains("jetbrains") {
        "JetBrains"
    } else if e.contains("desktop") || e == "local-agent" {
        "แอป Claude"
    } else {
        "terminal"
    }
}

/// The island asks at PreToolUse for this event (instead of at PermissionRequest).
pub fn asks_at_pre_tool_use(ev: &Event) -> bool {
    ev.agent == Agent::Claude && ev.name == "PreToolUse" && (ev.task.is_some() || ev.entry.as_deref().map(is_ide).unwrap_or(false))
}

// ── The user's own permission rules ─────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Rule {
    tool: String,
    spec: Option<String>,
    /// What a `/path` pattern in this rule is relative to.
    base: PathBuf,
}

#[derive(Debug, Default)]
pub struct Rules {
    allow: Vec<Rule>,
    deny: Vec<Rule>,
    ask: Vec<Rule>,
    /// permissions.additionalDirectories: edits there count as inside the project.
    dirs: Vec<String>,
}

fn parse_rule(text: &str, base: &Path) -> Option<Rule> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let (tool, spec) = match text.find('(') {
        Some(open) if text.ends_with(')') => (&text[..open], Some(text[open + 1..text.len() - 1].trim().to_string())),
        _ => (text, None),
    };
    let spec = spec.filter(|s| !s.is_empty() && s != "*");
    Some(Rule { tool: tool.trim().to_string(), spec, base: base.to_path_buf() })
}

impl Rules {
    /// Adds the `permissions` of one settings file.
    pub fn add_json(&mut self, root: &Value, base: &Path) {
        let Some(p) = root.get("permissions") else { return };
        let list = |key: &str| -> Vec<Rule> {
            p.get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter_map(|t| parse_rule(t, base)).collect())
                .unwrap_or_default()
        };
        self.allow.extend(list("allow"));
        self.deny.extend(list("deny"));
        self.ask.extend(list("ask"));
        if let Some(dirs) = p.get("additionalDirectories").and_then(Value::as_array) {
            self.dirs.extend(dirs.iter().filter_map(Value::as_str).map(str::to_string));
        }
    }

    fn add_file(&mut self, file: &Path, base: &Path) {
        let Ok(bytes) = std::fs::read(file) else { return };
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        if let Ok(root) = serde_json::from_slice::<Value>(bytes) {
            self.add_json(&root, base);
        }
    }

    /// Everything Claude Code would read for a session in `project`: the user's,
    /// the project's (shared and local) and the managed settings.
    pub fn load(project: &str) -> Rules {
        let mut rules = Rules::default();
        let home = crate::paths::home_dir();
        let user = crate::installer::config_path(Agent::Claude);
        rules.add_file(&user, &home);
        if !project.is_empty() {
            let root = PathBuf::from(project);
            rules.add_file(&root.join(".claude").join("settings.json"), &root);
            rules.add_file(&root.join(".claude").join("settings.local.json"), &root);
        }
        for managed in managed_settings() {
            rules.add_file(&managed, &home);
        }
        rules
    }
}

fn managed_settings() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut out = Vec::new();
        for var in ["ProgramFiles", "ProgramData"] {
            if let Some(dir) = std::env::var_os(var) {
                out.push(PathBuf::from(dir).join("ClaudeCode").join("managed-settings.json"));
            }
        }
        out
    }
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![PathBuf::from("/etc/claude-code/managed-settings.json")]
    }
}

// ── Matching ────────────────────────────────────────────────────────────────────

/// One tool call, in the terms the rules use.
struct Call<'a> {
    tool: &'a str,
    command: Option<String>,
    file: Option<String>,
    url: Option<String>,
    cwd: &'a str,
}

const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];
const SHELL_TOOLS: &[&str] = &["Bash", "PowerShell"];

fn text_field(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str).map(str::to_string)).filter(|s| !s.trim().is_empty())
}

impl<'a> Call<'a> {
    fn of(ev: &'a Event) -> Option<Call<'a>> {
        let tool = ev.tool.as_ref()?.name.as_str();
        Some(Call {
            tool,
            command: text_field(&ev.input, &["command"]),
            file: text_field(&ev.input, &["file_path", "notebook_path", "path"]),
            url: text_field(&ev.input, &["url"]),
            cwd: &ev.cwd,
        })
    }
}

fn windows_like(p: &str) -> bool {
    p.as_bytes().get(1) == Some(&b':') || p.starts_with("\\\\") || p.contains('\\')
}

fn norm_path(p: &str) -> String {
    let fwd = p.replace('\\', "/");
    if windows_like(p) {
        fwd.to_lowercase()
    } else {
        fwd
    }
}

fn is_absolute(p: &str) -> bool {
    p.starts_with('/') || p.starts_with('\\') || p.as_bytes().get(1) == Some(&b':')
}

fn join(dir: &str, rel: &str) -> String {
    let rel = rel.trim_start_matches("./");
    format!("{}/{}", dir.trim_end_matches(['/', '\\']), rel)
}

/// `*` (anything but `/`), `**` (anything), `?` (one character).
pub fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') if p.get(1) == Some(&'*') => {
                let rest = if p.get(2) == Some(&'/') { &p[3..] } else { &p[2..] };
                (0..=t.len()).any(|i| go(rest, &t[i..])) || go(&p[2..], t)
            }
            Some('*') => (0..=t.len()).take_while(|&i| i == 0 || t[i - 1] != '/').any(|i| go(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && t[0] != '/' && go(&p[1..], &t[1..]),
            Some(c) => !t.is_empty() && t[0] == *c && go(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    go(&p, &t)
}

/// `*` matches anything at all (shell commands have no path separators to respect).
fn wild(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            match rest.find(part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
    }
    true
}

fn command_matches(spec: &str, command: &str) -> bool {
    let command = command.trim();
    match spec.strip_suffix(":*") {
        Some(prefix) => command.starts_with(prefix.trim()),
        None => wild(spec, command),
    }
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split(['/', '?', '#']).next()?;
    let host = host.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn path_matches(spec: &str, file: &str, rule: &Rule, cwd: &str) -> bool {
    let home = crate::paths::home_dir().to_string_lossy().into_owned();
    let pattern = if let Some(abs) = spec.strip_prefix("//") {
        format!("/{abs}")
    } else if let Some(rest) = spec.strip_prefix("~/") {
        join(&home, rest)
    } else if let Some(rest) = spec.strip_prefix('/') {
        join(&rule.base.to_string_lossy(), rest)
    } else {
        join(cwd, spec)
    };
    let file = if is_absolute(file) { file.to_string() } else { join(cwd, file) };
    let (pattern, file) = (norm_path(&pattern), norm_path(&file));
    // A Windows drive path written as `//c/Users/...` in a rule.
    let pattern = match pattern.strip_prefix('/') {
        Some(rest) if windows_like(&file) && rest.as_bytes().get(1) == Some(&b'/') => format!("{}:{}", &rest[..1], &rest[1..]),
        _ => pattern,
    };
    glob(&pattern, &file) || glob(&format!("{}/**", pattern.trim_end_matches('/')), &file)
}

impl Rule {
    fn tool_matches(&self, tool: &str) -> bool {
        if self.tool == tool {
            return true;
        }
        if self.tool == "Edit" && EDIT_TOOLS.contains(&tool) {
            return true;
        }
        if let Some(server) = self.tool.strip_prefix("mcp__") {
            let server = server.trim_end_matches("__*");
            if !server.contains("__") {
                return tool.starts_with(&format!("mcp__{server}__"));
            }
        }
        false
    }

    fn matches(&self, call: &Call) -> bool {
        if !self.tool_matches(call.tool) {
            return false;
        }
        let Some(spec) = &self.spec else { return true };
        if SHELL_TOOLS.contains(&call.tool) {
            return call.command.as_deref().map(|c| command_matches(spec, c)).unwrap_or(false);
        }
        if let Some(domain) = spec.strip_prefix("domain:") {
            let domain = domain.trim().to_ascii_lowercase();
            return call
                .url
                .as_deref()
                .and_then(host_of)
                .map(|h| h == domain || h.ends_with(&format!(".{domain}")) || (domain.starts_with("*.") && h.ends_with(&domain[1..])))
                .unwrap_or(false);
        }
        if let Some(file) = &call.file {
            return path_matches(spec, file, self, call.cwd);
        }
        false
    }
}

// ── Shell commands that never needed asking ─────────────────────────────────────

const READ_ONLY: &[&str] = &[
    "ls", "dir", "pwd", "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep", "rg", "ag", "tree", "file",
    "stat", "du", "df", "which", "where", "whereis", "type", "echo", "printf", "date", "whoami", "id", "hostname", "uname",
    "printenv", "basename", "dirname", "realpath", "readlink", "nl", "od", "hexdump", "md5sum", "sha1sum", "sha256sum",
    "diff", "cmp", "comm", "column", "jq", "true", "false", "test", "cd", "pushd", "popd", "uniq", "cut", "tr", "rev",
    "get-childitem", "get-content", "get-location", "get-item", "test-path", "select-string", "get-command", "resolve-path",
    "measure-object", "get-date", "write-output", "write-host", "select-object", "sort-object", "format-list", "format-table",
    "gci", "gc", "gl", "sls",
];

const GIT_READ_ONLY: &[&str] = &[
    "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "cat-file", "grep",
    "merge-base", "name-rev", "whatchanged", "count-objects", "version", "help",
];

/// Splits on `&&`, `||`, `;`, `|` and new lines (quotes respected).
fn segments(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match quote {
            Some(q) => {
                cur.push(c);
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    cur.push(c);
                }
                ';' | '\n' | '|' | '&' => {
                    let doubled = chars.get(i + 1) == Some(&c);
                    if c == '&' && !doubled {
                        cur.push(c);
                    } else {
                        out.push(std::mem::take(&mut cur));
                        if doubled {
                            i += 1;
                        }
                    }
                }
                _ => cur.push(c),
            },
        }
        i += 1;
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn words(segment: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in segment.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '\'' || c == '"' => quote = Some(c),
            None if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn program(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

fn harmless_segment(segment: &str, mode: &str) -> bool {
    let w = words(segment);
    let Some(first) = w.first() else { return true };
    if first.contains('=') {
        return false;
    }
    let prog = program(first);
    let args: Vec<&str> = w[1..].iter().map(String::as_str).collect();
    let has = |flags: &[&str]| args.iter().any(|a| flags.iter().any(|f| a == f || a.starts_with(&format!("{f}="))));
    match prog.as_str() {
        "find" => !has(&["-exec", "-execdir", "-delete", "-ok", "-okdir", "-fprint", "-fprintf", "-fls", "-fprint0"]),
        "sed" => args.contains(&"-n") && !args.iter().any(|a| a.starts_with("-i") || *a == "--in-place"),
        "sort" => !args.iter().any(|a| a.starts_with("-o") || a.starts_with("--output")),
        "git" => {
            let sub = args.iter().find(|a| !a.starts_with('-')).copied().unwrap_or("");
            match sub {
                "branch" => !has(&["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "-f", "--force", "--set-upstream-to", "-u"]) && args.len() <= 3,
                "remote" => args.len() <= 2 && (args.len() == 1 || has(&["-v", "--verbose"])),
                "tag" => args.len() == 1 || has(&["-l", "--list"]),
                "stash" => args.get(1) == Some(&"list") || args.get(1) == Some(&"show"),
                "config" => has(&["--get", "--list", "-l", "--get-all"]),
                "worktree" => args.get(1) == Some(&"list"),
                "" => has(&["--version", "--help"]),
                s => GIT_READ_ONLY.contains(&s),
            }
        }
        "node" | "npm" | "npx" | "pnpm" | "yarn" | "bun" | "deno" | "python" | "python3" | "py" | "pip" | "cargo" | "rustc"
        | "go" | "java" | "dotnet" | "tsc" | "claude" | "codex" | "gemini" => {
            args.len() == 1 && matches!(args[0], "--version" | "-v" | "-V" | "version")
                || (matches!(prog.as_str(), "npm" | "pnpm") && matches!(args.first(), Some(&"ls") | Some(&"list") | Some(&"view") | Some(&"outdated")))
        }
        "mkdir" | "touch" => mode == "acceptEdits",
        p => READ_ONLY.contains(&p),
    }
}

/// Redirections that write nowhere.
fn without_quiet_redirects(command: &str) -> String {
    let mut s = command.to_string();
    for r in ["2>/dev/null", "2> /dev/null", ">/dev/null", "> /dev/null", "2>&1", "1>&2", ">&2", "2>nul", ">nul", "2>$null", ">$null", "| Out-Null"] {
        s = s.replace(r, " ");
    }
    s
}

fn writes_or_substitutes(command: &str) -> bool {
    let mut quote: Option<char> = None;
    let chars: Vec<char> = command.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                }
            }
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '`' || (c == '$' && chars.get(i + 1) == Some(&'(')) {
                    return true;
                }
            }
            None => match c {
                '\'' | '"' => quote = Some(c),
                '>' | '`' => return true,
                '$' if chars.get(i + 1) == Some(&'(') => return true,
                '<' if chars.get(i + 1) == Some(&'(') => return true,
                _ => {}
            },
        }
    }
    false
}

/// A rule list has a shell rule that covers this one command (no `&&` in it).
fn shell_rule(list: &[Rule], tool: &str, command: &str) -> bool {
    list.iter().any(|r| r.tool_matches(tool) && r.spec.as_deref().map(|spec| command_matches(spec, command)).unwrap_or(true))
}

/// Like Claude Code, every part of `a && b | c` is judged on its own: a rule for
/// `npm run test:*` doesn't let `npm run test && npm publish` through.
fn shell_would_ask(tool: &str, command: &str, mode: &str, rules: &Rules) -> bool {
    let cleaned = without_quiet_redirects(command);
    let parts = segments(&cleaned);
    if parts.iter().any(|p| shell_rule(&rules.deny, tool, p)) {
        return false;
    }
    if parts.iter().any(|p| shell_rule(&rules.ask, tool, p)) {
        return true;
    }
    if parts.len() <= 1 && shell_rule(&rules.allow, tool, command.trim()) {
        return false;
    }
    if writes_or_substitutes(&cleaned) {
        return true;
    }
    !parts.iter().all(|p| shell_rule(&rules.allow, tool, p) || harmless_segment(p, mode))
}

fn inside(file: &str, roots: &[&str]) -> bool {
    if !is_absolute(file) {
        return !file.contains("..");
    }
    let f = norm_path(file);
    roots.iter().filter(|r| !r.is_empty()).any(|r| {
        let r = norm_path(r);
        let r = r.trim_end_matches('/');
        f == r || f.starts_with(&format!("{r}/"))
    })
}

/// True when Claude Code, left to itself, would show a permission prompt for `ev`.
pub fn claude_would_ask(ev: &Event, rules: &Rules) -> bool {
    let Some(call) = Call::of(ev) else { return false };
    let mode = ev.permission_mode.as_deref().unwrap_or("default");
    if matches!(mode, "bypassPermissions" | "dontAsk" | "auto" | "plan") {
        return false;
    }
    if SHELL_TOOLS.contains(&call.tool) {
        return call.command.as_deref().map(|c| shell_would_ask(call.tool, c, mode, rules)).unwrap_or(true);
    }
    if rules.deny.iter().any(|r| r.matches(&call)) {
        return false;
    }
    if rules.ask.iter().any(|r| r.matches(&call)) {
        return true;
    }
    if rules.allow.iter().any(|r| r.matches(&call)) {
        return false;
    }
    match call.tool {
        t if EDIT_TOOLS.contains(&t) => {
            let project = ev.project_dir.as_deref().unwrap_or("");
            let mut roots: Vec<&str> = vec![ev.cwd.as_str(), project];
            roots.extend(rules.dirs.iter().map(String::as_str));
            mode == "default" || !call.file.as_deref().map(|f| inside(f, &roots)).unwrap_or(true)
        }
        "WebFetch" | "WebSearch" => true,
        t if t.starts_with("mcp__") => !t.ends_with("__getDiagnostics"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::normalize;
    use serde_json::json;

    fn ev(tool: &str, input: Value, mode: &str) -> Event {
        normalize(
            Agent::Claude,
            "",
            &json!({"hook_event_name":"PreToolUse","session_id":"s","cwd":"C:\\Work\\Shop","tool_name":tool,"tool_input":input,
                    "permission_mode":mode,"marshmori_entry":"claude-vscode","tool_use_id":"toolu_1"}),
        )
    }

    fn rules(v: Value) -> Rules {
        let mut r = Rules::default();
        r.add_json(&v, Path::new("C:\\Work\\Shop"));
        r
    }

    #[test]
    fn the_ide_front_ends_are_told_apart_from_the_terminal() {
        assert!(is_ide("claude-vscode"));
        assert!(is_ide("claude-desktop"));
        assert!(!is_ide("cli"));
        assert!(!is_ide("sdk-cli"));
        assert_eq!(surface_label("claude-vscode"), "VS Code");
        let e = ev("Bash", json!({"command":"npm test"}), "default");
        assert_eq!(e.entry.as_deref(), Some("claude-vscode"));
        assert_eq!(e.tool_use_id.as_deref(), Some("toolu_1"));
        assert!(asks_at_pre_tool_use(&e));
    }

    #[test]
    fn read_only_commands_never_turn_into_cards() {
        let none = Rules::default();
        for cmd in ["ls -la", "git status", "git log --oneline -5", "cat a.txt | grep foo", "cd src && ls", "rg TODO 2>/dev/null", "find . -name '*.ts'", "node --version", "sed -n '1,20p' a.rs"] {
            assert!(!claude_would_ask(&ev("Bash", json!({ "command": cmd }), "default"), &none), "{cmd}");
        }
        for cmd in ["npm test", "rm -rf build", "echo hi > a.txt", "git push", "find . -delete", "sed -i s/a/b/ x", "cat $(which x)", "git branch -D main", "FOO=1 ls"] {
            assert!(claude_would_ask(&ev("Bash", json!({ "command": cmd }), "default"), &none), "{cmd}");
        }
    }

    #[test]
    fn modes_decide_what_needs_asking() {
        let none = Rules::default();
        let edit = |mode: &str, file: &str| claude_would_ask(&ev("Edit", json!({"file_path": file}), mode), &none);
        assert!(edit("default", "C:\\Work\\Shop\\src\\a.ts"));
        assert!(!edit("acceptEdits", "C:\\Work\\Shop\\src\\a.ts"));
        assert!(edit("acceptEdits", "C:\\Windows\\hosts"), "outside the project still asks");
        assert!(!edit("auto", "C:\\Windows\\hosts"));
        assert!(!edit("bypassPermissions", "x"));
        assert!(!claude_would_ask(&ev("Read", json!({"file_path": "C:\\Work\\Shop\\a"}), "default"), &none));
        assert!(claude_would_ask(&ev("WebFetch", json!({"url": "https://example.com/a"}), "acceptEdits"), &none));
        assert!(claude_would_ask(&ev("mcp__github__create_issue", json!({}), "default"), &none));
        assert!(!claude_would_ask(&ev("mcp__ide__getDiagnostics", json!({}), "default"), &none));
        assert!(!claude_would_ask(&ev("Bash", json!({"command": "mkdir out"}), "acceptEdits"), &none));
        assert!(claude_would_ask(&ev("Bash", json!({"command": "mkdir out"}), "default"), &none));
    }

    #[test]
    fn the_users_rules_are_respected() {
        let r = rules(json!({"permissions": {
            "allow": ["Bash(npm run test:*)", "Bash(git commit *)", "WebFetch(domain:github.com)", "Edit(/src/**)", "mcp__notion"],
            "deny": ["Bash(rm *)"],
            "ask": ["Bash(git push *)"],
            "additionalDirectories": ["D:\\Shared"]
        }}));
        let bash = |cmd: &str| claude_would_ask(&ev("Bash", json!({ "command": cmd }), "default"), &r);
        assert!(!bash("npm run test:unit"));
        assert!(!bash("git commit -m 'x'"));
        assert!(!bash("rm -rf dist"), "denied anyway, no card");
        assert!(bash("git push origin main"));
        assert!(!bash("cd web && npm run test"), "every part allowed");
        assert!(bash("npm run test && npm publish"));
        assert!(!claude_would_ask(&ev("WebFetch", json!({"url": "https://api.github.com/x"}), "default"), &r));
        assert!(claude_would_ask(&ev("WebFetch", json!({"url": "https://evil.com/github.com"}), "default"), &r));
        assert!(!claude_would_ask(&ev("Edit", json!({"file_path": "C:\\Work\\Shop\\src\\deep\\a.ts"}), "default"), &r));
        assert!(claude_would_ask(&ev("Edit", json!({"file_path": "C:\\Work\\Shop\\README.md"}), "default"), &r));
        assert!(!claude_would_ask(&ev("Write", json!({"file_path": "D:\\Shared\\x.txt"}), "acceptEdits"), &r));
        assert!(!claude_would_ask(&ev("mcp__notion__search", json!({}), "default"), &r));
    }

    #[test]
    fn globs_and_wildcards() {
        assert!(glob("c:/a/**", "c:/a/b/c.ts"));
        assert!(glob("c:/a/*.ts", "c:/a/x.ts"));
        assert!(!glob("c:/a/*.ts", "c:/a/b/x.ts"));
        assert!(glob("c:/a/**/*.ts", "c:/a/x.ts"));
        assert!(wild("git *", "git push"));
        assert!(!wild("git *", "gitk"));
        assert!(wild("* --version", "node --version"));
        assert_eq!(segments("a && b || c; d | e & f"), vec!["a", "b", "c", "d", "e & f"]);
        assert_eq!(segments("echo 'a && b'"), vec!["echo 'a && b'"]);
    }
}
