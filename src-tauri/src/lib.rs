use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

const DEFAULT_PORT: u16 = 19420;
const DEFAULT_LAUNCH_MODE: &str = "on_demand";
/// Generic-password service holding the operator's durable bearer credential.
/// Same item the CLI falls back to in unmarked operator terminals (issue 9283a50).
const KEYCHAIN_OPERATOR_SERVICE: &str = "mandible-operator";
static CLIENT_AUTH_BOOTSTRAP_CONSUMED: AtomicBool = AtomicBool::new(false);
static CLIENT_AUTH_KEYCHAIN_ATTEMPTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct DesktopConfig {
    daemon_launch_mode: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            daemon_launch_mode: DEFAULT_LAUNCH_MODE.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct DaemonStatus {
    state: String,
    launch_mode: String,
    port: u16,
    pid: Option<u32>,
    pid_file: String,
    log_file: String,
    detail: Option<String>,
    healthy: bool,
}

#[command]
fn daemon_status(app: AppHandle) -> Result<DaemonStatus, String> {
    get_daemon_status(&app)
}

#[command]
fn daemon_get_launch_mode(app: AppHandle) -> Result<String, String> {
    Ok(read_desktop_config(&app)?.daemon_launch_mode)
}

#[command]
fn daemon_set_launch_mode(app: AppHandle, launch_mode: String) -> Result<DaemonStatus, String> {
    validate_launch_mode(&launch_mode)?;
    let mut config = read_desktop_config(&app).unwrap_or_default();
    config.daemon_launch_mode = launch_mode;
    write_desktop_config(&app, &config)?;
    get_daemon_status(&app)
}

#[command]
fn daemon_start(app: AppHandle) -> Result<DaemonStatus, String> {
    let status = get_daemon_status(&app)?;
    if status.healthy || status.state == "starting" {
        return Ok(status);
    }
    if status.state == "port_conflict" {
        return Ok(status);
    }

    let node = resolve_node_binary(&app)?;
    let entry = resolve_daemon_entry(&app)?;
    let repo_root = entry
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "failed to resolve daemon working directory".to_string())?;
    let repo_root = repo_root.to_path_buf();
    let port = daemon_port();

    let mut command = Command::new(node);
    command
        .arg(&entry)
        .current_dir(repo_root)
        .env("MANDIBLE_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command
        .spawn()
        .map_err(|error| format!("failed to start daemon: {error}"))?;

    wait_for_health(port, Duration::from_secs(4));
    get_daemon_status(&app)
}

#[command]
fn daemon_stop(app: AppHandle) -> Result<DaemonStatus, String> {
    if let Some(pid) = read_pid_file(pid_file_path()) {
        signal_process(pid, "TERM")?;
        wait_for_shutdown(daemon_port(), Duration::from_secs(4));
    }
    get_daemon_status(&app)
}

#[command]
fn daemon_restart(app: AppHandle) -> Result<DaemonStatus, String> {
    let _ = daemon_stop(app.clone());
    daemon_start(app)
}

/// Navigate the bundled desktop shell to an enrolled dashboard without ever
/// handing the same-user bootstrap proof to the renderer. The shell redeems the
/// proof for a bounded dashboard session itself (see
/// `exchange_credential_for_dashboard_session`) and injects only that session in
/// a URL fragment; fragments are not sent to the daemon and the UI removes it
/// before its first API request.
#[command]
fn client_auth_enroll(app: AppHandle) -> Result<bool, String> {
    if CLIENT_AUTH_BOOTSTRAP_CONSUMED.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    verify_same_user_daemon(&app)?;
    let Some(token) = read_client_auth_bootstrap(&client_auth_bootstrap_path())? else {
        return Ok(false);
    };
    fs::remove_file(client_auth_bootstrap_path())
        .map_err(|error| format!("failed to consume client-auth bootstrap file: {error}"))?;
    // The bootstrap proof authenticates as the operator exactly once, and the
    // handshake is an ordinary authenticated request, so redeeming it here
    // consumes it the same way the dashboard used to.
    let mut credential = token.into_bytes();
    let session = exchange_credential_for_dashboard_session(&credential);
    credential.fill(0);
    navigate_to_enrolled_dashboard(&app, &session?, None)?;
    Ok(true)
}

/// Log the desktop shell in after the one-shot bootstrap window has closed, by
/// reading the operator's durable keychain credential — the same
/// `mandible-operator` generic password the CLI falls back to (issue 9283a50).
/// Without this the app has no login path at all once the operator enrolled
/// anywhere else, because the bootstrap file exists only for first enrollment.
///
/// The durable credential never leaves this process. It is redeemed here for a
/// bounded dashboard session, scrubbed, and only that session is injected into
/// the webview. That containment is what makes the command safe to expose to
/// renderer JavaScript at all: the dashboard origin is a Tauri-capable remote
/// origin, so dashboard script (including injected script after an XSS) can
/// invoke this command and pass any `force` it likes. What it can obtain is
/// therefore at most a bounded operator dashboard session — the credential it
/// already holds — and the residual abuse is rotation denial-of-service:
/// repeated calls churn the single dashboard session and knock other surfaces
/// out. It can never read the durable keychain token.
///
/// `Ok(false)` means "nothing to enroll from" (no keychain item, or the
/// automatic attempt was already spent) — a normal state, not a failure.
///
/// Rotation semantics: the daemon keeps exactly ONE operator dashboard session
/// (`ClientAuthenticator.issueDashboardToken` drops every existing
/// `dashboard_handshake` entry before minting the next one), so enrolling here
/// revokes a session held by a regular browser profile, and a browser enrolling
/// later revokes this one. Enrollment is therefore only attempted when this
/// webview has no working session of its own, or when the operator explicitly
/// asks to log in.
#[command]
fn client_auth_keychain_enroll(
    app: AppHandle,
    route: Option<String>,
    force: Option<bool>,
) -> Result<bool, String> {
    // One automatic attempt per app process: a credential that does not produce
    // a session must not loop through enroll -> navigate -> enroll. An explicit
    // "Log in" action passes force and retries deliberately. `force` is
    // untrusted renderer input and is deliberately not a security control — it
    // only lifts the loop guard, bounded by the rotation-DoS residual above.
    if CLIENT_AUTH_KEYCHAIN_ATTEMPTED.swap(true, Ordering::AcqRel) && !force.unwrap_or(false) {
        return Ok(false);
    }
    verify_same_user_daemon(&app)?;
    let Some(mut credential) = read_keychain_operator_token(KEYCHAIN_OPERATOR_SERVICE)? else {
        return Ok(false);
    };
    let session = exchange_credential_for_dashboard_session(&credential);
    // Best-effort scrub: it narrows the window in which the durable credential
    // is resident, but cannot undo copies made by the allocator or the pipe.
    credential.fill(0);
    navigate_to_enrolled_dashboard(&app, &session?, route.as_deref())?;
    Ok(true)
}

/// Read the operator's durable bearer credential from the login keychain. An
/// absent item is the normal pre-enrollment state and yields `Ok(None)`. The
/// value stays in a byte buffer the caller can scrub and is never logged,
/// returned across IPC, or included in an error.
fn read_keychain_operator_token(service: &str) -> Result<Option<Vec<u8>>, String> {
    if !cfg!(target_os = "macos") {
        return Ok(None);
    }
    let output = match Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        // No `security` binary is the same situation as no keychain item.
        Err(_) => return Ok(None),
    };
    // Exit 44 is "item not found"; a declined keychain prompt is equally
    // non-fatal — both mean the shell has no credential to enroll with.
    if !output.status.success() {
        return Ok(None);
    }
    let mut credential = output.stdout;
    let start = credential
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(credential.len());
    let end = credential
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    credential.truncate(end);
    credential.drain(..start);
    Ok((!credential.is_empty()).then_some(credential))
}

/// Redeem a durable operator credential for a bounded dashboard session by
/// performing the dashboard's own handshake here, so the renderer only ever
/// sees the expiring session token.
///
/// The daemon speaks plain HTTP on loopback and already writes `Content-Length`
/// with `Connection: close`, so this uses the same dependency-free `TcpStream`
/// request style as `zone2_bootstrap` rather than adding an HTTP client crate.
fn exchange_credential_for_dashboard_session(credential: &[u8]) -> Result<String, String> {
    let port = daemon_port();
    let addr = format!("127.0.0.1:{port}")
        .to_socket_addrs()
        .map_err(|error| format!("failed to resolve the daemon address: {error}"))?
        .next()
        .ok_or_else(|| "failed to resolve the daemon address".to_string())?;

    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(2000))
        .map_err(|error| format!("failed to reach the daemon for enrollment: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut request = build_handshake_request(credential, port);
    let sent = stream.write_all(&request);
    // The request buffer is the only other place the credential is materialized.
    request.fill(0);
    sent.map_err(|error| format!("failed to send the enrollment handshake: {error}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("failed to read the enrollment handshake response: {error}"))?;
    parse_dashboard_session_response(&response)
}

/// Build the handshake request. Split out so the header shape is unit-testable
/// without a daemon; the credential is written as raw bytes so it is never
/// copied into an intermediate `String`.
fn build_handshake_request(credential: &[u8], port: u16) -> Vec<u8> {
    let mut request = Vec::with_capacity(credential.len() + 160);
    request.extend_from_slice(b"POST /api/client-auth/handshake HTTP/1.1\r\n");
    request.extend_from_slice(format!("Host: 127.0.0.1:{port}\r\n").as_bytes());
    request.extend_from_slice(b"Accept: application/json\r\n");
    request.extend_from_slice(b"Authorization: Bearer ");
    request.extend_from_slice(credential);
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(b"Content-Length: 0\r\n");
    request.extend_from_slice(b"Connection: close\r\n\r\n");
    request
}

/// Extract the dashboard session token from the handshake response. Failures
/// report the status only — a rejected credential must never be echoed back.
fn parse_dashboard_session_response(response: &str) -> Result<String, String> {
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "the daemon returned a malformed enrollment response".to_string())?;
    if !(200..300).contains(&status) {
        return Err(match status {
            401 | 403 => "the stored operator credential was rejected by the daemon".to_string(),
            409 => "no operator is configured; run `mandible user setup` first".to_string(),
            other => format!("the daemon refused the enrollment handshake (HTTP {other})"),
        });
    }
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or_else(|| "the daemon returned a malformed enrollment response".to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|_| "the daemon returned an unreadable enrollment response".to_string())?;
    match parsed.get("token").and_then(serde_json::Value::as_str) {
        Some(token) if !token.is_empty() => Ok(token.to_string()),
        _ => Err("the daemon returned no dashboard session".to_string()),
    }
}

/// Both enrollment paths carry the bounded session token in a URL fragment, so
/// it must be fragment-safe before it is spliced into the navigation URL.
fn is_url_fragment_safe(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_' | '.' | '~'))
}

/// Keep the dashboard on the operator's current view across enrollment instead
/// of resetting it to the default route. The route is caller-supplied, so it is
/// restricted to characters that stay inside the fragment; the loopback origin
/// and path are fixed here and can never be moved by the caller.
///
/// A route that already carries `mandible_auth` is refused: the dashboard reads
/// the first occurrence, so a forwarded stale value would shadow the session
/// injected here and strand a credential in the visible URL.
fn normalize_enrollment_route(route: Option<&str>) -> Result<String, String> {
    let route = route.map(str::trim).unwrap_or_default();
    if route.is_empty() {
        return Ok("/".to_string());
    }
    if route.to_ascii_lowercase().contains("mandible_auth") {
        return Err("desktop enrollment route may not carry a mandible_auth value".to_string());
    }
    let allowed = route.chars().all(|value| {
        value.is_ascii_alphanumeric()
            || matches!(
                value,
                '-' | '_' | '.' | '~' | '/' | '?' | '&' | '=' | '%' | ':' | '+' | ','
            )
    });
    if !route.starts_with('/') || !allowed {
        return Err("desktop enrollment route contains unsupported characters".to_string());
    }
    Ok(route.to_string())
}

fn navigate_to_enrolled_dashboard(
    app: &AppHandle,
    token: &str,
    route: Option<&str>,
) -> Result<(), String> {
    if !is_url_fragment_safe(token) {
        return Err("client-auth credential contains invalid URL-fragment characters".to_string());
    }
    let route = normalize_enrollment_route(route)?;
    let separator = if route.contains('?') { '&' } else { '?' };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    let url = format!(
        "http://127.0.0.1:{}/#{route}{separator}mandible_auth={token}",
        daemon_port()
    );
    let encoded = serde_json::to_string(&url)
        .map_err(|error| format!("failed to encode dashboard enrollment URL: {error}"))?;
    window
        .eval(&format!("window.location.replace({encoded});"))
        .map_err(|error| format!("failed to navigate to enrolled dashboard: {error}"))
}

fn verify_same_user_daemon(app: &AppHandle) -> Result<(), String> {
    let pid = read_pid_file(pid_file_path())
        .ok_or_else(|| "refusing desktop enrollment without a daemon pid file".to_string())?;
    if !process_alive(pid) || !check_health(daemon_port()) {
        return Err(
            "refusing desktop enrollment because the recorded daemon is not healthy".to_string(),
        );
    }
    #[cfg(unix)]
    {
        let current_uid = Command::new("id")
            .arg("-u")
            .output()
            .map_err(|error| format!("failed to inspect desktop uid: {error}"))?;
        let daemon_uid = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "uid="])
            .output()
            .map_err(|error| format!("failed to inspect daemon uid: {error}"))?;
        let current_uid = String::from_utf8_lossy(&current_uid.stdout);
        let daemon_uid = String::from_utf8_lossy(&daemon_uid.stdout);
        if current_uid.trim().is_empty() || !daemon_uid.trim().eq(current_uid.trim()) {
            return Err(
                "refusing desktop enrollment for a daemon owned by another user".to_string(),
            );
        }

        let expected_entry = resolve_daemon_entry(app)?
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize daemon entry: {error}"))?;
        let daemon_command = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .map_err(|error| format!("failed to inspect daemon command: {error}"))?;
        let command = String::from_utf8_lossy(&daemon_command.stdout);
        if !daemon_command.status.success()
            || !command.contains(&expected_entry.display().to_string())
        {
            return Err(
                "refusing desktop enrollment for an unexpected listener process".to_string(),
            );
        }
    }
    Ok(())
}

fn read_client_auth_bootstrap(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect client-auth bootstrap: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("client-auth bootstrap is not a protected regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("client-auth bootstrap permissions are broader than 0600".to_string());
        }
    }
    let token = fs::read_to_string(path)
        .map_err(|error| format!("failed to read client-auth bootstrap: {error}"))?;
    let token = token.trim();
    Ok((!token.is_empty()).then(|| token.to_string()))
}

fn client_auth_bootstrap_path() -> PathBuf {
    mandible_config_dir()
        .join("client-auth")
        .join("bootstrap-token")
}

fn mandible_config_dir() -> PathBuf {
    if let Ok(path) = std::env::var("MANDIBLE_CONFIG_DIR") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        home.join("Library")
            .join("Application Support")
            .join("Mandible")
            .join("config")
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".config"))
            .join("mandible")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"))
            .join("Mandible")
            .join("config")
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        home.join(".config").join("mandible")
    }
}

fn get_daemon_status(app: &AppHandle) -> Result<DaemonStatus, String> {
    let config = read_desktop_config(app).unwrap_or_default();
    let port = daemon_port();
    let pid_file = pid_file_path();
    let log_file = log_file_path();
    let pid = read_pid_file(pid_file.clone());
    let pid_alive = pid.map(process_alive).unwrap_or(false);
    let healthy = check_health(port);
    let port_open = tcp_port_open(port);

    let (state, detail) = if healthy {
        ("running".to_string(), None)
    } else if port_open && !pid_alive {
        (
            "port_conflict".to_string(),
            Some(format!(
                "Port {port} is accepting connections, but it is not responding as a Mandible daemon."
            )),
        )
    } else if pid.is_some() && !pid_alive {
        (
            "stale_pid".to_string(),
            Some("The daemon pid file exists, but that process is no longer running.".to_string()),
        )
    } else if pid_alive {
        (
            "starting".to_string(),
            Some("The daemon process is running but has not reported healthy yet.".to_string()),
        )
    } else {
        ("stopped".to_string(), None)
    };

    Ok(DaemonStatus {
        state,
        launch_mode: config.daemon_launch_mode,
        port,
        pid,
        pid_file: pid_file.display().to_string(),
        log_file: log_file.display().to_string(),
        detail,
        healthy,
    })
}

fn daemon_port() -> u16 {
    std::env::var("MANDIBLE_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn read_desktop_config(app: &AppHandle) -> Result<DesktopConfig, String> {
    let config_path = desktop_config_path(app)?;
    if !config_path.exists() {
        return Ok(DesktopConfig::default());
    }
    let raw = fs::read_to_string(&config_path)
        .map_err(|error| format!("failed to read desktop config: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("failed to parse desktop config: {error}"))
}

fn write_desktop_config(app: &AppHandle, config: &DesktopConfig) -> Result<(), String> {
    let config_path = desktop_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create desktop config dir: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("failed to serialize desktop config: {error}"))?;
    fs::write(&config_path, raw).map_err(|error| format!("failed to write desktop config: {error}"))
}

fn desktop_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("failed to resolve app config dir: {error}"))?;
    Ok(dir.join("desktop.json"))
}

fn resolve_daemon_entry(app: &AppHandle) -> Result<PathBuf, String> {
    // 1. Check Zone 2 mutable runtime (Bug: cc4688b)
    //    Zone 2 takes priority over everything — it may contain user patches
    //    that override the bundled or dev builds.
    let zone2_entry = zone2_runtime_path().join("dist").join("index.js");
    if zone2_entry.exists() {
        return Ok(zone2_entry);
    }

    // 2. Check bundled sidecar (Tauri resource bundle)
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("mandible-server").join("index.js"));
    if let Some(path) = bundled {
        if path.exists() {
            return Ok(path);
        }
    }

    // 3. Check dev path (repo root)
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "failed to resolve repo root".to_string())?
        .to_path_buf();
    let dist_entry = repo_root.join("dist").join("index.js");
    if dist_entry.exists() {
        return Ok(dist_entry);
    }

    Err("dist/index.js not found; build the daemon before launching the desktop shell".to_string())
}

/// Platform-specific Zone 2 runtime path.
/// Bug: cc4688b — Zone 2 mutable runtime infrastructure
fn zone2_runtime_path() -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));

    #[cfg(target_os = "macos")]
    {
        home.join("Library")
            .join("Application Support")
            .join("Mandible")
            .join("runtime")
    }

    #[cfg(target_os = "linux")]
    {
        home.join(".local")
            .join("share")
            .join("mandible")
            .join("runtime")
    }

    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"))
            .join("Mandible")
            .join("runtime")
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        home.join(".local")
            .join("share")
            .join("mandible")
            .join("runtime")
    }
}

/// Bug: cc4688b — Zone 2 status: returns path and whether it exists
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct Zone2Status {
    path: String,
    available: bool,
}

#[command]
fn zone2_status() -> Zone2Status {
    let zone2 = zone2_runtime_path();
    let available = zone2.join("dist").join("index.js").exists();
    Zone2Status {
        path: zone2.display().to_string(),
        available,
    }
}

/// Bug: cc4688b — trigger Zone 2 bootstrap by calling the daemon API
#[command]
async fn zone2_bootstrap() -> Result<String, String> {
    let port = daemon_port();

    // Use a simple TCP-based HTTP POST (no external HTTP crate dependency)
    let addr = format!("127.0.0.1:{port}");
    let addr = addr
        .to_socket_addrs()
        .map_err(|e| format!("failed to resolve address: {e}"))?
        .next()
        .ok_or_else(|| "no address resolved".to_string())?;

    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(2000))
        .map_err(|e| format!("failed to connect to daemon: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let request = format!(
        "POST /api/runtime/bootstrap HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("failed to send request: {e}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("failed to read response: {e}"))?;

    if response.contains("200") {
        Ok("Bootstrap request sent successfully".to_string())
    } else {
        Err(format!("Bootstrap request failed: {response}"))
    }
}

fn resolve_node_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("node"));
    if let Some(path) = bundled {
        if path.exists() {
            return Ok(path);
        }
    }
    Ok(PathBuf::from("node"))
}

fn pid_file_path() -> PathBuf {
    cache_dir().join("daemon.pid")
}

fn log_file_path() -> PathBuf {
    cache_dir().join("launchd-stderr.log")
}

fn cache_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".cache")
        .join("mandible")
}

fn read_pid_file(path: PathBuf) -> Option<u32> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
}

fn process_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn signal_process(pid: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .arg(format!("-{signal}"))
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("failed to signal daemon: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to signal daemon process {pid}"))
    }
}

fn validate_launch_mode(launch_mode: &str) -> Result<(), String> {
    if matches!(launch_mode, "on_demand" | "manual") {
        Ok(())
    } else {
        Err(format!("unsupported launch mode: {launch_mode}"))
    }
}

fn tcp_port_open(port: u16) -> bool {
    ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .and_then(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok())
        .is_some()
}

fn check_health(port: u16) -> bool {
    let addr = match ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    {
        Some(addr) => addr,
        None => return false,
    };

    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));

    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn wait_for_health(port: u16, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if check_health(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn wait_for_shutdown(port: u16, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !tcp_port_open(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Set the window and webview background to match the app's dark theme (#0b0f14).
            // This prevents a white flash in the title-bar area on macOS when using
            // titleBarStyle: "Transparent" — the native window chrome would otherwise
            // default to the system light color before the webview paints.
            // Bug: d41755b — white title bar in Tauri app on macOS
            if let Some(window) = app.get_webview_window("main") {
                let dark = tauri::window::Color(11, 15, 20, 255);
                let _ = window.set_background_color(Some(dark));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            daemon_get_launch_mode,
            daemon_set_launch_mode,
            daemon_start,
            daemon_stop,
            daemon_restart,
            client_auth_enroll,
            client_auth_keychain_enroll,
            zone2_status,
            zone2_bootstrap
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mandible app");
}

#[cfg(test)]
mod tests {
    use super::{
        build_handshake_request, is_url_fragment_safe, normalize_enrollment_route,
        parse_dashboard_session_response, read_client_auth_bootstrap,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("mandible-tauri-auth-{name}-{nonce}"))
    }

    #[test]
    fn reads_a_protected_bootstrap_token() {
        let path = temp_path("protected");
        fs::write(&path, "desktop-token\n").expect("write bootstrap");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
        }
        assert_eq!(
            read_client_auth_bootstrap(&path).expect("read bootstrap"),
            Some("desktop-token".to_string()),
        );
        fs::remove_file(path).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_group_readable_bootstrap_token() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("broad");
        fs::write(&path, "desktop-token").expect("write bootstrap");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("chmod");
        assert!(read_client_auth_bootstrap(&path).is_err());
        fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn accepts_only_fragment_safe_credentials() {
        assert!(is_url_fragment_safe("abc-123_XYZ.token~"));
        assert!(!is_url_fragment_safe(""));
        // A credential carrying fragment or script syntax must never be spliced
        // into the navigation URL.
        assert!(!is_url_fragment_safe("token&mandible_auth=other"));
        assert!(!is_url_fragment_safe("token#/settings"));
        assert!(!is_url_fragment_safe("token with space"));
        assert!(!is_url_fragment_safe("\"});alert(1);//"));
    }

    #[test]
    fn normalizes_the_dashboard_return_route() {
        assert_eq!(normalize_enrollment_route(None).expect("default"), "/");
        assert_eq!(normalize_enrollment_route(Some("  ")).expect("blank"), "/");
        assert_eq!(
            normalize_enrollment_route(Some("/issues?repo=mandible&issue=54b5677")).expect("route"),
            "/issues?repo=mandible&issue=54b5677",
        );
        assert!(normalize_enrollment_route(Some("issues")).is_err());
        assert!(normalize_enrollment_route(Some("/issues#/settings")).is_err());
        assert!(normalize_enrollment_route(Some("/issues\"};alert(1)")).is_err());
    }

    #[test]
    fn refuses_a_route_that_shadows_the_injected_session() {
        // The dashboard reads the first mandible_auth value, so a forwarded one
        // would win over the session injected after it.
        assert!(normalize_enrollment_route(Some("/issues?mandible_auth=stolen")).is_err());
        assert!(normalize_enrollment_route(Some("/issues?MANDIBLE_AUTH=stolen")).is_err());
        assert!(normalize_enrollment_route(Some("/issues?repo=mandible")).is_ok());
    }

    #[test]
    fn builds_a_loopback_handshake_request_with_the_credential_as_bearer() {
        let request = build_handshake_request(b"operator-pat", 19420);
        let rendered = String::from_utf8(request).expect("utf8 request");
        assert!(rendered.starts_with("POST /api/client-auth/handshake HTTP/1.1\r\n"));
        // The daemon's write boundary requires a loopback Host and no Origin.
        assert!(rendered.contains("Host: 127.0.0.1:19420\r\n"));
        assert!(!rendered.to_ascii_lowercase().contains("origin:"));
        assert!(rendered.contains("Authorization: Bearer operator-pat\r\n"));
        assert!(rendered.contains("Content-Length: 0\r\n"));
        assert!(rendered.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn reads_only_the_session_token_out_of_a_handshake_response() {
        let response =
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 61\r\n\r\n\
{\"token\":\"dashboard-session\",\"expires_at\":1,\"user\":{\"slug\":\"op\"}}";
        assert_eq!(
            parse_dashboard_session_response(response).expect("session"),
            "dashboard-session",
        );
    }

    #[test]
    fn reports_handshake_failures_without_echoing_the_credential() {
        let rejected = parse_dashboard_session_response(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
        )
        .expect_err("rejected");
        assert!(rejected.contains("rejected by the daemon"));

        let unconfigured = parse_dashboard_session_response(
            "HTTP/1.1 409 Conflict\r\nContent-Length: 2\r\n\r\n{}",
        )
        .expect_err("unconfigured");
        assert!(unconfigured.contains("mandible user setup"));

        assert!(parse_dashboard_session_response("HTTP/1.1 500 Server Error\r\n\r\n").is_err());
        assert!(parse_dashboard_session_response("not http at all").is_err());
        // A 200 without a usable token is a failure, never an empty enrollment.
        assert!(
            parse_dashboard_session_response("HTTP/1.1 200 OK\r\n\r\n{\"token\":\"\"}").is_err()
        );
    }
}
