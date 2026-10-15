// A tiny append-only log in %LOCALAPPDATA%\Marshmori\marshmori.log, capped at 1 MB.
// Only for "why didn't my hooks work" questions: no prompts, no file contents.

use std::io::Write;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 1024 * 1024;

pub fn line(message: impl AsRef<str>) {
    let message = message.as_ref();
    #[cfg(debug_assertions)]
    eprintln!("[marshmori] {message}");
    let _guard = LOCK.lock();
    let path = crate::paths::log_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {}", crate::paths::stamp(), message);
    }
}
