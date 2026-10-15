// Files dropped on Mamori: what they are, and copying them into the chat folder so
// the agent's own CLI can open them. The island only ever sees names and sizes.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

const MAX_IMAGE: u64 = 10 * 1024 * 1024;
const MAX_PDF: u64 = 30 * 1024 * 1024;
const MAX_TEXT: u64 = 1024 * 1024;
const MAX_FILES: usize = 5;
/// Files a whole conversation may refer to.
const MAX_STAGED: usize = 12;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonc", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go",
    "java", "kt", "kts", "c", "h", "cpp", "hpp", "cc", "cs", "swift", "php", "rb", "lua", "dart", "scala", "html", "htm",
    "css", "scss", "sass", "less", "xml", "svg", "yml", "yaml", "toml", "ini", "cfg", "conf", "log", "sh", "bash", "zsh",
    "ps1", "psm1", "bat", "cmd", "sql", "vue", "svelte", "astro", "prisma", "graphql", "gql", "dockerfile", "gitignore",
    "editorconfig", "r", "m", "pl", "ex", "exs", "erl", "hs", "clj", "tf", "proto", "gradle", "properties", "lock",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Image,
    Pdf,
    Text,
    /// Not for the chat, but a task can work in it ("สั่งงานในโฟลเดอร์นี้").
    Folder,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: FileKind,
    pub supported: bool,
    pub reason: Option<String>,
}

/// A copy of an attached file inside the chat folder.
#[derive(Debug, Clone)]
pub struct Staged {
    /// Path relative to the chat folder ("files/1a2b3c4d-report.pdf").
    pub rel: String,
    pub kind: FileKind,
}

fn extension(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match path.extension() {
        Some(e) => e.to_string_lossy().to_ascii_lowercase(),
        // "Dockerfile", ".gitignore"…
        None => name.trim_start_matches('.').to_string(),
    }
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn mb(bytes: u64) -> String {
    format!("{:.0} MB", bytes as f64 / 1024.0 / 1024.0)
}

pub fn inspect_one(path: &Path) -> FileInfo {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    let meta = std::fs::metadata(path);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mut info = FileInfo { path: path.display().to_string(), name, size, kind: FileKind::Other, supported: false, reason: None };
    match meta {
        Err(_) => {
            info.reason = Some("เปิดไฟล์ไม่ได้".into());
            return info;
        }
        Ok(m) if m.is_dir() => {
            info.kind = FileKind::Folder;
            info.reason = Some("เป็นโฟลเดอร์ — สั่งงานในโฟลเดอร์นี้ได้".into());
            return info;
        }
        _ => {}
    }
    let ext = extension(path);
    if image_mime(&ext).is_some() {
        info.kind = FileKind::Image;
        info.supported = size <= MAX_IMAGE;
        if !info.supported {
            info.reason = Some(format!("รูปใหญ่เกิน {}", mb(MAX_IMAGE)));
        }
    } else if ext == "pdf" {
        info.kind = FileKind::Pdf;
        info.supported = size <= MAX_PDF;
        if !info.supported {
            info.reason = Some(format!("PDF ใหญ่เกิน {}", mb(MAX_PDF)));
        }
    } else if TEXT_EXTENSIONS.contains(&ext.as_str()) || looks_like_text(path, size) {
        info.kind = FileKind::Text;
        info.supported = size <= MAX_TEXT;
        if !info.supported {
            info.reason = Some("ไฟล์ข้อความยาวเกิน 1 MB".into());
        }
    } else {
        info.reason = Some("ยังไม่รองรับไฟล์ชนิดนี้ (รองรับ รูป, PDF, ไฟล์ข้อความ/โค้ด)".into());
    }
    info
}

/// Small files with no extension we know: valid UTF-8 without NUL bytes counts as text.
fn looks_like_text(path: &Path, size: u64) -> bool {
    if size == 0 || size > MAX_TEXT {
        return false;
    }
    match std::fs::read(path) {
        Ok(bytes) => !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok(),
        Err(_) => false,
    }
}

pub fn inspect(paths: &[String]) -> Vec<FileInfo> {
    paths.iter().take(MAX_FILES).map(|p| inspect_one(Path::new(p))).collect()
}

/// A short, stable tag for a file's identity (path, size, time): the same file is
/// copied once however many turns refer to it.
fn tag(path: &Path, size: u64) -> String {
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // FNV-1a, 64 bits: plenty to keep a dozen file names apart.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.to_string_lossy().bytes().chain(size.to_le_bytes()).chain(mtime.to_le_bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", h as u32)
}

/// A name safe on every file system and in every command line: ASCII letters, digits,
/// dot, dash and underscore, extension kept.
fn safe_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let clean = clean.trim_matches('.').to_string();
    let (stem, ext) = match clean.rfind('.') {
        Some(i) if i > 0 => (clean[..i].to_string(), clean[i..].to_string()),
        _ => (clean.clone(), String::new()),
    };
    let stem: String = stem.chars().take(40).collect();
    let stem = if stem.trim_matches('_').is_empty() { "file".to_string() } else { stem };
    format!("{stem}{}", ext.chars().take(12).collect::<String>())
}

/// Copies the attached files into `dir` (the chat folder's "files"), keyed by the
/// original path. Unsupported files stop the message with a reason.
pub fn stage(paths: &[String], dir: &Path) -> Result<HashMap<String, Staged>, String> {
    let mut out = HashMap::new();
    if paths.is_empty() {
        return Ok(out);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("เตรียมไฟล์ไม่ได้: {e}"))?;
    for p in paths.iter().rev() {
        if out.contains_key(p) {
            continue;
        }
        if out.len() >= MAX_STAGED {
            break;
        }
        let path = Path::new(p);
        let info = inspect_one(path);
        if !info.supported {
            return Err(format!("{}: {}", info.name, info.reason.unwrap_or_else(|| "ใช้ไม่ได้".into())));
        }
        let file = format!("{}-{}", tag(path, info.size), safe_name(&info.name));
        let target = dir.join(&file);
        let same = std::fs::metadata(&target).map(|m| m.len() == info.size).unwrap_or(false);
        if !same {
            std::fs::copy(path, &target).map_err(|e| format!("{}: คัดลอกไม่ได้ ({e})", info.name))?;
        }
        let folder = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "files".into());
        out.insert(p.clone(), Staged { rel: format!("{folder}/{file}"), kind: info.kind });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_recognised() {
        let dir = std::env::temp_dir().join(format!("marshmori-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("notes.md");
        std::fs::write(&text, "# hi").unwrap();
        let unknown_text = dir.join("README");
        std::fs::write(&unknown_text, "plain words").unwrap();
        let binary = dir.join("blob.bin");
        std::fs::write(&binary, [0u8, 1, 2, 3]).unwrap();
        let png = dir.join("shot.PNG");
        std::fs::write(&png, [137u8, 80, 78, 71]).unwrap();

        assert_eq!(inspect_one(&text).kind, FileKind::Text);
        assert_eq!(inspect_one(&unknown_text).kind, FileKind::Text);
        assert!(!inspect_one(&binary).supported);
        let img = inspect_one(&png);
        assert_eq!(img.kind, FileKind::Image);
        assert!(img.supported);
        assert!(!inspect_one(&dir).supported);

        let out = dir.join("staged");
        let staged = stage(&[text.display().to_string(), png.display().to_string()], &out).unwrap();
        let t = &staged[&text.display().to_string()];
        assert!(t.rel.starts_with("staged/") && t.rel.ends_with("-notes.md"), "{}", t.rel);
        assert_eq!(std::fs::read_to_string(out.join(t.rel.trim_start_matches("staged/"))).unwrap(), "# hi");
        assert_eq!(staged[&png.display().to_string()].kind, FileKind::Image);
        // Staging again copies nothing new and gives the same names.
        let again = stage(&[text.display().to_string()], &out).unwrap();
        assert_eq!(again[&text.display().to_string()].rel, t.rel);
        assert!(stage(&[binary.display().to_string()], &out).is_err());
        assert_eq!(safe_name("รายงาน ไตรมาส.pdf"), "file.pdf");
        assert_eq!(safe_name("my report (v2).PDF"), "my_report__v2_.PDF");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
