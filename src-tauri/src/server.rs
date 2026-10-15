// The local endpoint the relay talks to: HTTP on 127.0.0.1, a random port and a
// random token, both written to %APPDATA%\Marshmori\endpoint.json at every launch.
//
// * Only 127.0.0.1 is bound, so nothing outside this computer can reach it.
// * The token stops web pages from posting to it (a browser can't add the custom
//   header without a CORS preflight, which this server never answers).
// * The Host check stops DNS-rebinding tricks.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::Read;

use tauri::AppHandle;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::paths;

const MAX_BODY: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

pub fn random_token() -> String {
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(paths::now_ms());
        h.write_u64(std::process::id() as u64);
        h.write_u64(i);
        h.write_usize(&out as *const String as usize);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// An agent still has AIMoji's old relay in its hooks (its config couldn't be moved
/// over): keep an endpoint.json where that relay looks too, so it still reaches us.
static LEGACY_RELAYS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_legacy_relays(on: bool) {
    LEGACY_RELAYS.store(on, std::sync::atomic::Ordering::Relaxed);
}

fn endpoint_files() -> Vec<std::path::PathBuf> {
    let mut files = vec![paths::endpoint_file()];
    if LEGACY_RELAYS.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(dir) = paths::legacy_data_dir().filter(|d| d.is_dir()) {
            files.push(dir.join("endpoint.json"));
        }
    }
    files
}

pub fn write_endpoint(ep: &Endpoint, wait_secs: u64) -> Result<(), String> {
    let json = serde_json::json!({
        "port": ep.port,
        "token": ep.token,
        "waitSecs": wait_secs,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    let mut result = Ok(());
    for (i, file) in endpoint_files().into_iter().enumerate() {
        let written = paths::write_atomic(&file, json.to_string().as_bytes()).map_err(|e| e.to_string());
        if i == 0 {
            result = written;
        }
    }
    result
}

/// Removes endpoint.json if it is still ours, so relays stop trying at once.
pub fn remove_endpoint(ep: &Endpoint) {
    for path in endpoint_files() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if text.contains(&ep.token) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

pub fn start(app: AppHandle, wait_secs: u64) -> Result<Endpoint, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("เปิด server ไม่ได้: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "ไม่ทราบพอร์ตของ server".to_string())?;
    let ep = Endpoint { port, token: random_token() };
    write_endpoint(&ep, wait_secs)?;

    let token = ep.token.clone();
    std::thread::Builder::new()
        .name("marshmori-server".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                let app = app.clone();
                let token = token.clone();
                let _ = std::thread::Builder::new()
                    .name("marshmori-hook".into())
                    .spawn(move || handle(&app, request, &token, port));
            }
        })
        .map_err(|e| e.to_string())?;
    crate::log::line(format!("listening on 127.0.0.1:{port}"));
    Ok(ep)
}

fn header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

/// Same length and same bytes, without stopping at the first difference.
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn query_param(url: &str, key: &str) -> String {
    url.split_once('?')
        .map(|(_, q)| q)
        .unwrap_or("")
        .split('&')
        .find_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            (k == key).then(|| v.to_string())
        })
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect()
}

fn handle(app: &AppHandle, mut req: Request, token: &str, port: u16) {
    let respond = |req: Request, code: u16, body: String| {
        let mut resp = Response::from_string(body).with_status_code(code);
        if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
            resp = resp.with_header(h);
        }
        let _ = req.respond(resp);
    };

    if req.method() != &Method::Post || !req.url().starts_with("/hook") {
        return respond(req, 404, String::new());
    }
    let host_ok = header(&req, "Host")
        .map(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
        .unwrap_or(false);
    // AIMoji (0.3 and before) relays still say it the old way until their hooks move.
    let token_ok = header(&req, "X-Marshmori-Token")
        .or_else(|| header(&req, "X-AIMoji-Token"))
        .map(|t| same_secret(t, token))
        .unwrap_or(false);
    if !host_ok || !token_ok {
        return respond(req, 403, String::new());
    }

    let mut body = Vec::new();
    if req.as_reader().take(MAX_BODY).read_to_end(&mut body).is_err() {
        return respond(req, 400, String::new());
    }
    let agent = query_param(req.url(), "agent");
    let event = query_param(req.url(), "event");
    let answer = crate::pipeline::handle_hook(app, &agent, &event, &body);
    respond(req, 200, answer.unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_long_and_different() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn query_params_are_cleaned() {
        assert_eq!(query_param("/hook?agent=codex&event=Stop", "agent"), "codex");
        assert_eq!(query_param("/hook?agent=codex&event=Stop", "event"), "Stop");
        assert_eq!(query_param("/hook?agent=a%20b<c>", "agent"), "a20bc");
        assert_eq!(query_param("/hook", "agent"), "");
    }

    #[test]
    fn secrets_compare_exactly() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "abcd"));
    }
}
