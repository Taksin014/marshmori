// Preferences, kept as plain JSON in %APPDATA%\Marshmori\settings.json.
// There are no secrets: the chat goes through the agents' own signed-in CLIs.

use serde::{Deserialize, Serialize};

/// What the app calls the mascot by default (its full name is Marshmori).
pub const DEFAULT_NAME: &str = "Mamori";
const DEFAULT_COLOR: &str = "cream";
const COLORS: &[&str] = &["cream", "mint", "lilac", "peach", "butter", "sky"];
const PROVIDERS: &[&str] = &["auto", "claude", "codex", "antigravity", "gemini"];
/// How the island looks: "auto" follows the system's light or dark mode.
const LOOKS: &[&str] = &["auto", "dark", "light", "forest", "midnight"];
/// Bumped when a default changes in a way old files should pick up (see `migrate`).
/// 4 (0.5): "always allow" lasts until the next prompt, so 0.4's permanent rules
/// ("rules") are dropped from the file.
const VERSION: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// What the mascot is called in the UI.
    pub mascot_name: String,
    pub color: String,
    pub sound: bool,
    pub volume: f64,
    pub eyes_follow: bool,
    /// Show permission prompts in the island and answer them from there.
    pub approvals: bool,
    /// How long a card waits before the agent asks in its own UI.
    pub approval_timeout: u64,
    /// Ask before Antigravity runs a terminal command (needs the hooks reinstalled).
    pub antigravity_approvals: bool,
    pub shortcuts: bool,
    pub hide_in_fullscreen: bool,
    pub toasts: bool,
    pub autostart: bool,
    /// "primary" or "cursor" (the display the mouse is on when Marshmori starts).
    pub screen: String,
    /// Which signed-in CLI the chat uses: "auto" (the first one installed), or
    /// claude | codex | antigravity | gemini.
    pub chat_provider: String,
    pub onboarded: bool,
    /// When Mamori reaches out to the mouse pointer: "all" (approvals, finished work
    /// and problems), "approvals" (only when an agent asks), or "off".
    pub roam: String,
    /// Hide the island when nothing is going on (it peeks out when the pointer comes
    /// up to the top of the screen).
    pub auto_hide: bool,
    /// The island's colours: "auto" (light or dark with the system), "dark" (Mamori
    /// stands out most), "light", or a theme: "forest", "midnight".
    pub island_look: String,
    /// How long the pointer has to stay at the island before Mamori peeks out or the
    /// island opens (ms), so passing by on the way to the top of the screen doesn't.
    pub hover_delay: u64,
    /// How much the island bounces as it opens: "soft", "boing" (wobbles back, the
    /// default) or "extra".
    pub island_bounce: String,
    /// How much things move: "system" follows Windows' "Animation effects" (off: the
    /// island glides without bouncing and Mamori doesn't reach out to the pointer), or
    /// "full" (always the whole bounce and the reach, whatever Windows says).
    pub motion: String,
    /// What Mamori nudges you with when it reaches out to the pointer: "head" (its
    /// head on its long neck), "hand" (a long arm that taps the pointer), or "auto"
    /// (whichever suits the news: the head for a question or a problem, a tap for
    /// finished work).
    pub reach_with: String,
    /// "สั่งงาน Mamori ที่นี่" in Explorer's right-click menu on folders.
    pub folder_menu: bool,
    /// Agents whose hooks you took off yourself: Marshmori doesn't connect them again
    /// by itself (it connects every other agent it finds when it starts).
    pub hooks_off: Vec<String>,
    pub settings_version: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mascot_name: DEFAULT_NAME.into(),
            color: DEFAULT_COLOR.into(),
            sound: true,
            volume: 0.6,
            eyes_follow: true,
            approvals: true,
            approval_timeout: 110,
            antigravity_approvals: false,
            shortcuts: true,
            hide_in_fullscreen: true,
            toasts: true,
            autostart: false,
            screen: "primary".into(),
            chat_provider: "auto".into(),
            onboarded: false,
            roam: "all".into(),
            auto_hide: true,
            island_look: "auto".into(),
            hover_delay: 600,
            island_bounce: "boing".into(),
            motion: "system".into(),
            reach_with: "auto".into(),
            folder_menu: true,
            hooks_off: Vec::new(),
            settings_version: VERSION,
        }
    }
}

impl Settings {
    /// Keeps every value inside what the rest of the app expects.
    pub fn sanitized(mut self) -> Self {
        let name: String = self.mascot_name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(24).collect();
        self.mascot_name = if name.is_empty() { DEFAULT_NAME.into() } else { name };
        if !COLORS.contains(&self.color.as_str()) {
            self.color = DEFAULT_COLOR.into();
        }
        if !matches!(self.roam.as_str(), "all" | "approvals" | "off") {
            self.roam = "all".into();
        }
        if !self.volume.is_finite() {
            self.volume = 0.6;
        }
        self.volume = self.volume.clamp(0.0, 1.0);
        self.approval_timeout = self.approval_timeout.clamp(20, 590);
        self.hover_delay = self.hover_delay.min(3000);
        if self.screen != "cursor" {
            self.screen = "primary".into();
        }
        if !PROVIDERS.contains(&self.chat_provider.as_str()) {
            self.chat_provider = "auto".into();
        }
        if !LOOKS.contains(&self.island_look.as_str()) {
            self.island_look = "auto".into();
        }
        if !matches!(self.reach_with.as_str(), "auto" | "head" | "hand") {
            self.reach_with = "auto".into();
        }
        if !matches!(self.island_bounce.as_str(), "soft" | "boing" | "extra") {
            self.island_bounce = "boing".into();
        }
        if !matches!(self.motion.as_str(), "system" | "full") {
            self.motion = "system".into();
        }
        self.hooks_off.retain(|a| matches!(a.as_str(), "claude" | "codex" | "antigravity"));
        self.hooks_off.dedup();
        self
    }

    /// Older files still carry their version's defaults: 0.1 a mint "Moji", 0.2
    /// "MarshMoji" and an OpenAI chat. Defaults nobody changed move to today's
    /// (Mamori, cream, the first signed-in CLI); anything the user picked is kept.
    fn migrate(mut self) -> Self {
        if self.settings_version < 2 && self.color == "mint" {
            self.color = DEFAULT_COLOR.into();
        }
        if self.settings_version < 3 {
            if self.mascot_name == "Moji" || self.mascot_name == "MarshMoji" {
                self.mascot_name = DEFAULT_NAME.into();
            }
            self.chat_provider = match self.chat_provider.as_str() {
                "openai" => "codex".into(),
                "claude" => "claude".into(),
                _ => "auto".into(),
            };
        }
        self.settings_version = VERSION;
        self
    }
}

/// A file without a version comes from 0.1 (missing fields would otherwise take
/// today's defaults, version included).
fn fill_missing(raw: &serde_json::Value, mut s: Settings) -> Settings {
    if raw.get("settingsVersion").is_none() {
        s.settings_version = 1;
    }
    s
}

pub fn load() -> Settings {
    match std::fs::read(crate::paths::settings_file()) {
        Ok(bytes) => {
            let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
            let loaded = parse(bytes);
            if loaded.1 {
                let _ = save(&loaded.0);
            }
            loaded.0
        }
        Err(_) => Settings::default(),
    }
}

/// The settings in a file, and whether they changed on the way in (and should be saved).
fn parse(bytes: &[u8]) -> (Settings, bool) {
    let Ok(raw) = serde_json::from_slice::<serde_json::Value>(bytes) else { return (Settings::default(), false) };
    let Ok(s) = serde_json::from_value::<Settings>(raw.clone()) else { return (Settings::default(), false) };
    let old = fill_missing(&raw, s);
    let migrated = old.settings_version < VERSION;
    (old.migrate().sanitized(), migrated)
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    crate::paths::write_atomic(&crate::paths::settings_file(), &json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_or_partial_files_still_load() {
        let (s, _) = parse(br#"{"color":"lilac","volume":3,"claudeModel":"x","islandTheme":"dark"}"#);
        assert_eq!(s.color, "lilac");
        assert_eq!(s.volume, 1.0);
        assert!(s.approvals);
        assert_eq!(s.roam, "all");
        assert!(s.auto_hide);
        // 0.2's "islandTheme" (a colour) is not the island look of today.
        assert_eq!(s.island_look, "auto");
        assert_eq!(s.hover_delay, 600);
        assert_eq!(s.reach_with, "auto");
        // 0.5's files have no bounce setting yet: they get the bouncy default.
        assert_eq!(s.island_bounce, "boing");
        // Files from before the motion setting follow Windows, as the app always did.
        assert_eq!(s.motion, "system");
        let (s, _) = parse(br#"{"islandLook":"forest","hoverDelay":9000,"reachWith":"hand","islandBounce":"soft","motion":"full","settingsVersion":3}"#);
        assert_eq!(s.island_look, "forest");
        assert_eq!(s.hover_delay, 3000);
        assert_eq!(s.reach_with, "hand");
        assert_eq!(s.island_bounce, "soft");
        assert_eq!(s.motion, "full");
    }

    #[test]
    fn permanent_allow_rules_from_0_4_are_dropped() {
        let (s, changed) = parse(br#"{"mascotName":"Mamori","settingsVersion":3,"rules":[{"id":"r1","agent":"claude","cwd":"C:\\w","tool":"Bash","command":"npm test","label":"x","created":1}]}"#);
        assert!(changed, "saved again, without the rules");
        let saved = serde_json::to_value(&s).unwrap();
        assert!(saved.get("rules").is_none());
        assert_eq!(s.settings_version, VERSION);
    }

    #[test]
    fn untouched_old_defaults_become_mamori() {
        // What 0.1 wrote on first run.
        let (s, changed) = parse(br#"{"mascotName":"Moji","color":"mint","onboarded":true}"#);
        assert!(changed);
        assert_eq!(s.mascot_name, "Mamori");
        assert_eq!(s.color, "cream");
        assert_eq!(s.settings_version, VERSION);

        // What 0.2 wrote: MarshMoji, and a chat that used an OpenAI key.
        let (s, changed) = parse(br#"{"mascotName":"MarshMoji","color":"cream","chatProvider":"openai","settingsVersion":2}"#);
        assert!(changed);
        assert_eq!(s.mascot_name, "Mamori");
        assert_eq!(s.chat_provider, "codex");

        // Choices the user made are kept.
        let (s, _) = parse(r#"{"mascotName":"ต้นกล้า","color":"peach","settingsVersion":2}"#.as_bytes());
        assert_eq!(s.mascot_name, "ต้นกล้า");
        assert_eq!(s.color, "peach");
        assert_eq!(s.chat_provider, "auto");

        // Already migrated: nothing to do, and "Moji" picked on purpose stays.
        let (s, changed) = parse(br#"{"mascotName":"Moji","color":"mint","settingsVersion":4,"chatProvider":"gemini"}"#);
        assert!(!changed);
        assert_eq!(s.mascot_name, "Moji");
        assert_eq!(s.color, "mint");
        assert_eq!(s.chat_provider, "gemini");
    }

    #[test]
    fn a_new_install_gets_mamori() {
        let s = Settings::default();
        assert_eq!(s.mascot_name, "Mamori");
        assert_eq!(s.color, "cream");
        assert_eq!(s.roam, "all");
        assert_eq!(s.chat_provider, "auto");
    }

    #[test]
    fn bad_values_are_put_back_in_range() {
        let s = Settings {
            color: "neon".into(),
            approval_timeout: 5,
            chat_provider: "x".into(),
            roam: "sometimes".into(),
            island_look: "neon".into(),
            reach_with: "feet".into(),
            island_bounce: "wobbly".into(),
            motion: "never".into(),
            mascot_name: "  \u{7}  ".into(),
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(s.color, "cream");
        assert_eq!(s.roam, "all");
        assert_eq!(s.approval_timeout, 20);
        assert_eq!(s.chat_provider, "auto");
        assert_eq!(s.island_look, "auto");
        assert_eq!(s.reach_with, "auto");
        assert_eq!(s.island_bounce, "boing");
        assert_eq!(s.motion, "system");
        assert_eq!(s.mascot_name, "Mamori");
    }
}
