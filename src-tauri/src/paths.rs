// Where Marshmori keeps its files.
//
// Windows: settings and endpoint.json in %APPDATA%\Marshmori, the hook relay and the
// log in %LOCALAPPDATA%\Marshmori. The relay (hook/src/main.rs) computes the same data
// directory on its own, so the two must stay in sync. MARSHMORI_DATA_DIR overrides
// it for tests.

use std::path::PathBuf;

#[cfg(windows)]
pub const HOOK_EXE: &str = "marshmori-hook.exe";
#[cfg(not(windows))]
pub const HOOK_EXE: &str = "marshmori-hook";

pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Settings and endpoint.json.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MARSHMORI_DATA_DIR") {
        return PathBuf::from(dir);
    }
    roaming_base().join(app_dir_name())
}

/// The relay binary and the log.
pub fn local_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MARSHMORI_DATA_DIR") {
        return PathBuf::from(dir).join("local");
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"))
            .join(app_dir_name())
    }
    #[cfg(not(windows))]
    {
        data_dir()
    }
}

#[cfg(windows)]
fn app_dir_name() -> &'static str {
    "Marshmori"
}

#[cfg(not(windows))]
fn app_dir_name() -> &'static str {
    "marshmori"
}

fn roaming_base() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".local").join("share"))
    }
}

pub fn endpoint_file() -> PathBuf {
    data_dir().join("endpoint.json")
}

pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

/// The stable copy of the relay that the agents' hook configs point at.
pub fn relay_path() -> PathBuf {
    local_dir().join("bin").join(HOOK_EXE)
}

pub fn log_file() -> PathBuf {
    local_dir().join("marshmori.log")
}

/// Writes `bytes` next to `path` and renames it over: a crash or a full disk leaves
/// the old file whole instead of half a file.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{file_name}.marshmori-{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o600);
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(err)
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Local date-time stamp for backup file names, e.g. 20261003-142501.
pub fn stamp() -> String {
    // No chrono: days-from-civil on UTC plus the local offset is overkill for a
    // file name, so this is UTC and says so.
    let secs = now_ms() / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_are_right() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_729), (2026, 10, 3));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
