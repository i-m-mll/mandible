use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{command, AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

const DEFAULT_PORT: u16 = 29420;
const PRODUCTION_ORIGIN: &str = "https://app.mandible.localhost:19420";
const LEGACY_PRODUCTION_ORIGIN: &str = "http://127.0.0.1:19420";

fn dashboard_origin_from_cutover(raw: Option<&[u8]>) -> &'static str {
    let Some(raw) = raw else {
        return PRODUCTION_ORIGIN;
    };
    let Ok(journal) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return PRODUCTION_ORIGIN;
    };
    if journal["schema"] != "mandible-local-session-cutover@1" {
        return PRODUCTION_ORIGIN;
    }
    let expected_main = journal["manifest"]["instances"]
        .as_array()
        .is_some_and(|instances| {
            instances.iter().any(|instance| {
                instance["role"] == "main"
                    && instance["public_port"] == 19420
                    && instance["candidate"]["instance_id"] == "production"
            })
        });
    if !expected_main {
        return PRODUCTION_ORIGIN;
    }
    match journal["state"].as_str() {
        Some(
            "preparing" | "prepared" | "activating" | "migration" | "rolling_back" | "rolled_back"
            | "recovery_failed",
        ) => LEGACY_PRODUCTION_ORIGIN,
        _ => PRODUCTION_ORIGIN,
    }
}

fn desktop_dashboard_origin() -> &'static str {
    let journal = fs::read(
        mandible_config_dir()
            .join("local-sessions")
            .join("cutover.json"),
    )
    .ok();
    dashboard_origin_from_cutover(journal.as_deref())
}
fn admits_native_command_origin(origin: &str) -> bool {
    origin == PRODUCTION_ORIGIN
}

fn bind_session_cookie_to_production(
    mut cookie: tauri::webview::Cookie<'static>,
) -> Result<(tauri::webview::Cookie<'static>, tauri::Url), String> {
    let origin = tauri::Url::parse(PRODUCTION_ORIGIN)
        .map_err(|error| format!("invalid trusted production origin: {error}"))?;
    let host = origin
        .host_str()
        .ok_or_else(|| "trusted production origin has no host".to_string())?;
    if cookie.name() != "__Host-mandible-session"
        || cookie.domain().is_some()
        || cookie.path() != Some("/")
        || cookie.secure() != Some(true)
        || cookie.http_only() != Some(true)
    {
        return Err(
            "the daemon returned a session cookie outside the host-only contract".to_string(),
        );
    }
    // Wry's URL-less setter maps an absent domain to an empty NSHTTPCookie
    // domain. Supplying this one exact host places the otherwise host-only
    // __Host cookie in the production origin's native cookie store only.
    cookie.set_domain(host.to_string());
    Ok((cookie, origin))
}
const DEFAULT_LAUNCH_MODE: &str = "on_demand";
/// Generic-password service holding the operator's durable bearer credential.
/// Same item the CLI falls back to in unmarked operator terminals (issue 9283a50).
const KEYCHAIN_OPERATOR_SERVICE: &str = "mandible-operator";
static CLIENT_AUTH_BOOTSTRAP_CONSUMED: AtomicBool = AtomicBool::new(false);
static CLIENT_AUTH_KEYCHAIN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static ACCESS_APPROVALS_IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

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
    dashboard_origin: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct SecureLocalConnectionsStatus {
    state: String,
    storage_root: String,
    root_digest: Option<String>,
    verified_at: Option<String>,
}

fn resolve_ca_setup_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("local-ca-trust.mjs");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "failed to resolve Mandible source root".to_string())?
        .to_path_buf();
    let script = repo.join("scripts").join("local-ca-trust.mjs");
    if script.is_file() {
        return Ok(script);
    }
    Err("secure-local-connections setup resource is missing from the desktop app".to_string())
}

fn run_ca_setup_command(
    app: &AppHandle,
    command_name: &str,
) -> Result<SecureLocalConnectionsStatus, String> {
    let script = resolve_ca_setup_script(app)?;
    let node = resolve_node_binary(app)?;
    let output = Command::new(node)
        .arg(script)
        .arg(command_name)
        .env("MANDIBLE_HOME", mandible_home())
        .output()
        .map_err(|error| format!("failed to run secure-local-connections setup: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "secure-local-connections {} failed: {}",
            command_name,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("secure-local-connections setup returned invalid status: {error}"))
}

fn secure_connections_renderer_precheck(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    let url = window
        .url()
        .map_err(|error| format!("failed to inspect desktop origin: {error}"))?;
    if !admits_native_command_origin(&url.origin().ascii_serialization()) {
        return Err(
            "secure-local-connections setup is available only from the production desktop origin"
                .to_string(),
        );
    }
    Ok(())
}

#[command]
fn secure_local_connections_status(app: AppHandle) -> Result<SecureLocalConnectionsStatus, String> {
    secure_connections_renderer_precheck(&app)?;
    run_ca_setup_command(&app, "status")
}

#[command]
async fn secure_local_connections_setup(
    app: AppHandle,
) -> Result<SecureLocalConnectionsStatus, String> {
    secure_connections_renderer_precheck(&app)?;
    tauri::async_runtime::spawn_blocking(move || run_ca_setup_command(&app, "setup"))
        .await
        .map_err(|error| format!("secure-local-connections setup task failed: {error}"))?
}

fn resolve_ca_trust_helper(app: &AppHandle) -> Result<PathBuf, String> {
    let script = resolve_ca_setup_script(app)?;
    let bundled = script.with_file_name("local-ca-trust-helper");
    if bundled.is_file() {
        return Ok(bundled);
    }
    let source = script
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("src-tauri/resources/local-ca-trust-helper"))
        .ok_or_else(|| "failed to resolve native trust helper source".to_string())?;
    if source.is_file() {
        return Ok(source);
    }
    Err("native macOS trust helper is missing from the desktop app".to_string())
}

fn show_native_setup_result(app: &AppHandle, headline: &str, detail: &str) {
    match resolve_ca_trust_helper(app) {
        Ok(helper) => {
            match Command::new(helper).arg("--result").arg(headline).arg(detail).status() {
                Ok(status) if status.success() => (),
                Ok(status) => eprintln!("could not show secure-local-connections result: native alert exited with {status}; {headline}: {detail}"),
                Err(error) => eprintln!("could not show secure-local-connections result: {error}; {headline}: {detail}"),
            }
        }
        Err(error) => eprintln!(
            "could not show secure-local-connections result: {error}; {headline}: {detail}"
        ),
    }
}

fn is_secure_connections_setup_link(url: &tauri::Url) -> bool {
    url.as_str() == "mandible://connections/setup"
}

fn browser_access_reference(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "mandible" || url.host_str() != Some("access")
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || url.path() != "/approve" || url.fragment().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next()?;
    if key != "reference" || value.len() != 12
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) || pairs.next().is_some()
    {
        return None;
    }
    Some(value.into_owned())
}

fn approve_browser_access(reference: &str) -> Result<(), String> {
    verify_same_user_daemon()?;
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("failed to create browser-access client: {error}"))?;
    let Some(mut credential) = read_keychain_operator_token(KEYCHAIN_OPERATOR_SERVICE)? else {
        return Err("the installed app has no operator credential".to_string());
    };
    if !is_credential_material(&credential) {
        credential.fill(0);
        return Err("the installed-app operator credential is malformed".to_string());
    }
    let bearer = std::str::from_utf8(&credential)
        .map_err(|_| "operator credential is not UTF-8".to_string())?;
    let response = client
        .post(format!("{PRODUCTION_ORIGIN}/api/client-auth/pairing/approve"))
        .bearer_auth(bearer)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "reference": reference }).to_string())
        .send();
    credential.fill(0);
    let response = response.map_err(|error| format!("browser-access approval failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("the daemon refused browser access (HTTP {})", response.status()));
    }
    Ok(())
}

fn launch_browser_access_approval(url: &tauri::Url) {
    let Some(reference) = browser_access_reference(url) else { return; };
    let approvals = ACCESS_APPROVALS_IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()));
    if !approvals.lock().expect("access approval lock poisoned").insert(reference.clone()) {
        return;
    }
    std::thread::spawn(move || {
        if let Err(error) = approve_browser_access(&reference) {
            eprintln!("mandible: {error}");
        }
        approvals.lock().expect("access approval lock poisoned").remove(&reference);
    });
}

fn launch_native_ca_setup(handle: AppHandle, active: Arc<AtomicBool>) {
    if active.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        match run_ca_setup_command(&handle, "setup") {
            Ok(_) => show_native_setup_result(
                &handle,
                "Secure local connections are ready for this Mac account.",
                "You can now open Mandible in this browser. Browser sign-in is separate.",
            ),
            Err(error) => show_native_setup_result(
                &handle,
                "Secure local connections setup did not finish.",
                &error,
            ),
        }
        active.store(false, Ordering::Release);
    });
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
    if status.dashboard_origin == LEGACY_PRODUCTION_ORIGIN {
        return Err("Mandible is changing its local connection. Restart the existing Mandible service before opening the desktop app.".to_string());
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
    let log_file = log_file_path();
    let (log_stdout, log_stderr) = open_daemon_log(&log_file)?;

    let mut command = Command::new(node);
    command
        .arg(&entry)
        .current_dir(repo_root)
        .env("MANDIBLE_PORT", port.to_string())
        // The daemon rotates this file on a timer. Naming it explicitly makes
        // the rotation target and the actual stderr destination the same path
        // by construction rather than by both defaulting to the same constant.
        .env("MANDIBLE_STDERR_LOG_PATH", &log_file)
        .stdin(Stdio::null())
        .stdout(log_stdout)
        .stderr(log_stderr);

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

/// What an enrollment attempt produced. The distinction between a daemon that
/// answered and a daemon that was never reached is load-bearing: only the
/// former means a one-shot bootstrap proof has been spent.
enum Enrollment {
    /// No credential to enroll with — a normal state, not a failure.
    Missing,
    /// An opaque browser session cookie was installed in the webview.
    Session,
    /// The daemon answered and refused. Any one-shot proof is now spent.
    Refused(String),
    /// The daemon was never reached. A one-shot proof is still good.
    Unreachable(String),
}

/// Remove a bootstrap proof the daemon has already seen.
///
/// The removal is best-effort by design — the session, if one was issued, is
/// already valid — but a proof that can never be deleted makes every subsequent
/// launch read a dead file and fail its exchange, so the failure is reported
/// rather than swallowed. Only the path is named; the file's contents are not
/// read here and never appear in the warning.
fn discard_spent_proof(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!(
            "mandible: failed to remove the spent client-auth bootstrap proof at {} ({error}); \
             desktop enrollment will keep failing on this stale file until it can be deleted",
            path.display(),
        ),
    }
}

/// Local prechecks shared by both enrollment commands. The window lookup runs
/// up front so a missing webview fails before any credential is read, rather
/// than after a proof has already been redeemed.
fn enrollment_precheck(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    let url = window
        .url()
        .map_err(|error| format!("failed to inspect desktop origin: {error}"))?;
    if !admits_native_command_origin(&url.origin().ascii_serialization()) {
        return Err(
            "native enrollment is available only to the registered production origin".to_string(),
        );
    }
    verify_same_user_daemon()
}

/// Redeem the one-shot bootstrap proof through the trusted production origin.
/// The response cookie is installed directly in the webview; no credential is
/// returned to renderer JavaScript or placed in a URL.
#[command]
fn client_auth_enroll(app: AppHandle) -> Result<bool, String> {
    if CLIENT_AUTH_BOOTSTRAP_CONSUMED.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    let path = client_auth_bootstrap_path();
    enrollment_precheck(&app)?;
    let Some(mut credential) = read_client_auth_bootstrap(&path)? else {
        return Ok(false);
    };
    let enrollment = install_browser_session(&app, &credential);
    credential.fill(0);
    match enrollment {
        Enrollment::Session => {
            discard_spent_proof(&path);
            Ok(true)
        }
        Enrollment::Missing => Ok(false),
        Enrollment::Refused(message) => {
            discard_spent_proof(&path);
            Err(message)
        }
        Enrollment::Unreachable(message) => {
            CLIENT_AUTH_BOOTSTRAP_CONSUMED.store(false, Ordering::Release);
            Err(message)
        }
    }
}

/// Log the desktop shell in after the one-shot bootstrap window has closed, by
/// reading the operator's durable keychain credential — the same
/// `mandible-operator` generic password the CLI falls back to (issue 9283a50).
/// Without this the app has no login path at all once the operator enrolled
/// anywhere else, because the bootstrap file exists only for first enrollment.
///
/// The durable credential never leaves this process. It is redeemed here for a
/// opaque browser session, scrubbed, and installs only the HttpOnly cookie in
/// the webview. The exact production-origin precheck runs before keychain I/O.
///
/// `Ok(false)` means "nothing to enroll from" (no keychain item, or another
/// keychain attempt is already in flight) — a normal state, not a failure.
///
/// Enrollment is attempted only when this webview has no working session of its
/// own, or when the operator explicitly retries after an honest failure. The
/// server contract keeps independent browser session families.
#[command]
fn client_auth_keychain_enroll(app: AppHandle, route: Option<String>) -> Result<bool, String> {
    // Rust prevents concurrent reads/exchanges but does not accept renderer
    // retry policy as an argument. The UI owns its one-attempt-per-episode state
    // machine; releasing this guard after every result lets a later genuine 401
    // recover without restarting the app.
    if CLIENT_AUTH_KEYCHAIN_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    let result = (|| {
        if route
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty() && value.trim() != "/")
        {
            return Err(
                "native enrollment no longer accepts renderer-controlled return routes".to_string(),
            );
        }
        enrollment_precheck(&app)?;
        let Some(mut credential) = read_keychain_operator_token(KEYCHAIN_OPERATOR_SERVICE)? else {
            return Ok(false);
        };
        let outcome = install_browser_session(&app, &credential);
        credential.fill(0);
        match outcome {
            Enrollment::Session => Ok(true),
            Enrollment::Missing => Ok(false),
            Enrollment::Refused(message) | Enrollment::Unreachable(message) => Err(message),
        }
    })();
    CLIENT_AUTH_KEYCHAIN_IN_FLIGHT.store(false, Ordering::Release);
    result
}

fn install_browser_session(app: &AppHandle, credential: &[u8]) -> Enrollment {
    if !is_credential_material(credential) {
        return Enrollment::Unreachable(
            "refusing to send a malformed operator credential".to_string(),
        );
    }
    let client = match reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return Enrollment::Unreachable(format!("failed to create enrollment client: {error}"))
        }
    };
    let url = format!("{PRODUCTION_ORIGIN}/api/client-auth/native-enrollment");
    let bearer = match std::str::from_utf8(credential) {
        Ok(value) => value,
        Err(_) => return Enrollment::Unreachable("operator credential is not UTF-8".to_string()),
    };
    let response = match client.post(&url).bearer_auth(bearer).send() {
        Ok(response) => response,
        Err(error) => {
            return Enrollment::Unreachable(format!(
                "failed to reach the trusted Mandible origin: {error}"
            ))
        }
    };
    if !response.status().is_success() {
        return Enrollment::Refused(format!(
            "the daemon refused native enrollment (HTTP {})",
            response.status()
        ));
    }
    let cookies = response.headers().get_all(reqwest::header::SET_COOKIE);
    let Some(raw_cookie) = cookies.iter().find_map(|value| {
        value
            .to_str()
            .ok()
            .filter(|value| value.starts_with("__Host-mandible-session="))
    }) else {
        return Enrollment::Refused("the daemon returned no browser session cookie".to_string());
    };
    let cookie = match tauri::webview::Cookie::parse(raw_cookie.to_string()) {
        Ok(cookie) => cookie.into_owned(),
        Err(error) => {
            return Enrollment::Refused(format!(
                "the daemon returned an invalid session cookie: {error}"
            ))
        }
    };
    let (cookie, production_url) = match bind_session_cookie_to_production(cookie) {
        Ok(bound) => bound,
        Err(message) => return Enrollment::Refused(message),
    };
    let Some(window) = app.get_webview_window("main") else {
        return Enrollment::Unreachable("desktop main window is unavailable".to_string());
    };
    if let Err(error) = window.set_cookie(cookie) {
        return Enrollment::Unreachable(format!(
            "failed to install the browser session cookie: {error}"
        ));
    }
    match window.cookies_for_url(production_url) {
        Ok(cookies)
            if cookies.iter().any(|stored| {
                stored.name() == "__Host-mandible-session"
                    && stored.domain() == Some("app.mandible.localhost")
            }) => {}
        Ok(_) => {
            return Enrollment::Unreachable(
                "the native cookie store did not retain the production session".to_string(),
            )
        }
        Err(error) => {
            return Enrollment::Unreachable(format!(
                "failed to verify the production browser session cookie: {error}"
            ))
        }
    }
    Enrollment::Session
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
    let mut raw = output.stdout;
    extract_credential(&mut raw, "keychain")
}

/// Trim, validate, and take ownership of a credential read from a local secret
/// store, scrubbing the full source buffer before returning.
///
/// Validation is the header-injection gate: a poisoned keychain item or
/// bootstrap file containing CR/LF (or anything else outside the token grammar)
/// would otherwise be spliced verbatim into an `Authorization` header and could
/// smuggle further headers into the request. Rejection is fail-closed and the
/// message never quotes the value.
fn extract_credential(raw: &mut Vec<u8>, source: &str) -> Result<Option<Vec<u8>>, String> {
    let start = raw
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(raw.len());
    let end = raw
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    let credential = raw[start..end].to_vec();
    // Scrub the whole original read buffer, not just the trimmed span.
    raw.fill(0);
    if credential.is_empty() {
        return Ok(None);
    }
    if !is_credential_material(&credential) {
        let mut credential = credential;
        credential.fill(0);
        return Err(format!(
            "the {source} operator credential is not a valid Mandible token"
        ));
    }
    Ok(Some(credential))
}

/// The Mandible token grammar: `mandible_pat_` plus base64url payload, i.e.
/// ASCII alphanumerics and `-._~`. It is deliberately the same allowlist that
/// guards fragment injection, so a credential that may be sent can also be
/// carried in a URL and neither check can drift from the other.
fn is_credential_material(value: &[u8]) -> bool {
    !value.is_empty()
        && value
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
}

fn verify_same_user_daemon() -> Result<(), String> {
    let (pid_file, port) = enrollment_daemon_registration()?;
    let pid = read_pid_file(pid_file)
        .ok_or_else(|| "the registered Mandible service is not running".to_string())?;
    if !process_alive(pid) || !check_health(port) {
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

        if !registered_pid_owns_listener(pid, port)? {
            return Err(
                "the registered Mandible service does not own its local connection".to_string(),
            );
        }

        // Do not compare the daemon command with a path derived from
        // CARGO_MANIFEST_DIR. Release bundles may be built in disposable
        // worktrees, and coupling enrollment to that build checkout makes the
        // installed app fail as soon as the worktree disappears. The security
        // boundary here is the OS user: a same-uid process can already read the
        // same login Keychain item and user-owned Mandible state, while the uid
        // comparison above still refuses a listener owned by another user.
    }
    Ok(())
}

fn registered_pid_owns_listener(pid: u32, port: u16) -> Result<bool, String> {
    let output = Command::new("lsof")
        .args([
            "-nP",
            "-F",
            "n",
            "-a",
            "-p",
            &pid.to_string(),
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("cannot verify the Mandible service connection: {error}"))?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line == format!("n127.0.0.1:{port}")))
}

fn enrollment_daemon_registration() -> Result<(PathBuf, u16), String> {
    let path = mandible_config_dir()
        .join("local-sessions")
        .join("cutover.json");
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((pid_file_path(), daemon_port()))
        }
        Err(error) => {
            return Err(format!(
                "cannot inspect the Mandible service registration: {error}"
            ))
        }
    };
    enrollment_daemon_registration_from_journal(&raw)
}

fn enrollment_daemon_registration_from_journal(raw: &[u8]) -> Result<(PathBuf, u16), String> {
    let journal: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|_| "the Mandible service registration is invalid".to_string())?;
    if journal["state"] != "complete" {
        return Ok((pid_file_path(), daemon_port()));
    }
    if journal["schema"] != "mandible-local-session-cutover@1" {
        return Err("the Mandible service registration has an unknown format".to_string());
    }
    let registered: Vec<_> = journal["manifest"]["instances"]
        .as_array()
        .ok_or_else(|| "the Mandible service registration has no instances".to_string())?
        .iter()
        .filter(|instance| {
            instance["role"] == "main" && instance["candidate"]["instance_id"] == "production"
        })
        .collect();
    if registered.len() != 1 {
        return Err(
            "the Mandible service registration has no unique production service".to_string(),
        );
    }
    let env = &registered[0]["candidate"]["process"]["env"];
    let pid_file = env["MANDIBLE_PID_FILE"]
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "the Mandible service registration has no valid PID location".to_string())?;
    let port = env["MANDIBLE_PORT"]
        .as_str()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| "the Mandible service registration has no valid private port".to_string())?;
    Ok((pid_file, port))
}

fn read_client_auth_bootstrap(path: &Path) -> Result<Option<Vec<u8>>, String> {
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
    let mut raw =
        fs::read(path).map_err(|error| format!("failed to read client-auth bootstrap: {error}"))?;
    extract_credential(&mut raw, "bootstrap")
}

fn client_auth_bootstrap_path() -> PathBuf {
    mandible_config_dir()
        .join("client-auth")
        .join("bootstrap-token")
}

/// Issue 24f0316 — Mandible config lives under the durable root `~/.mandible`
/// on every platform now, so the desktop shell, the daemon
/// (`src/platform-paths.ts`) and the CLI (`cli/api.sh`) all derive one path.
/// The per-platform split this replaced also carried a `Mandible`/`mandible`
/// casing mismatch that only went unnoticed because macOS filesystems are
/// case-insensitive by default.
fn mandible_config_dir() -> PathBuf {
    if let Ok(path) = std::env::var("MANDIBLE_CONFIG_DIR") {
        if !path.trim().is_empty() {
            return resolve_user_path(&path);
        }
    }
    mandible_home().join("config")
}

/// The durable-state root. `MANDIBLE_HOME` overrides it wholesale, matching
/// `getMandibleHome()` in `src/platform-paths.ts`.
fn mandible_home() -> PathBuf {
    if let Ok(path) = std::env::var("MANDIBLE_HOME") {
        if !path.trim().is_empty() {
            return resolve_user_path(&path);
        }
    }
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".mandible")
}

fn resolve_user_path(raw: &str) -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    resolve_user_path_from(raw, &home)
}

fn resolve_user_path_from(raw: &str, home: &std::path::Path) -> PathBuf {
    let trimmed = raw.trim();
    let expanded = if trimmed == "~" {
        home.to_path_buf()
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(expanded)
    }
}

fn get_daemon_status(app: &AppHandle) -> Result<DaemonStatus, String> {
    let config = read_desktop_config(app).unwrap_or_default();
    let dashboard_origin = desktop_dashboard_origin();
    let port = if dashboard_origin == LEGACY_PRODUCTION_ORIGIN {
        19420
    } else {
        daemon_port()
    };
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
        dashboard_origin: dashboard_origin.to_string(),
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

/// The Zone 2 runtime path: `~/.mandible/runtime/`.
/// Bug: cc4688b — Zone 2 mutable runtime infrastructure
/// Issue 24f0316 — Zone 2 holds agent-authored patches, which is durable
/// state, so it moved under the durable root along with the rest of it.
/// Mirrors `computeZone2Path()` in `src/runtime-manager.ts`.
fn zone2_runtime_path() -> PathBuf {
    mandible_home().join("runtime")
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

/// Open the daemon log for an app-launched daemon and return append handles for
/// its stdout and stderr.
///
/// Both handles are `O_APPEND`. That is load-bearing twice over: two handles on
/// one file only interleave safely when every write seeks to end-of-file first,
/// and the daemon's own rotation truncates this file in place, which an
/// append-mode writer follows back to offset 0 while a fixed-offset writer would
/// turn into a sparse hole.
///
/// A log that cannot be opened is a hard error rather than a fall back to
/// `Stdio::null()`. A daemon nobody can diagnose is the defect this path exists
/// to fix, and the same unwritable directory would fail the daemon's pid file
/// moments later anyway — so failing here reports the real cause instead of
/// hiding it behind a silent, logless start.
fn open_daemon_log(path: &Path) -> Result<(Stdio, Stdio), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create daemon log directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open daemon log {}: {error}", path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("failed to open daemon log {}: {error}", path.display()))?;
    Ok((Stdio::from(stdout), Stdio::from(stderr)))
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
            let setup_item = MenuItemBuilder::with_id(
                "secure_local_connections_setup",
                "Set up secure local connections…",
            )
            .build(app)?;
            let connections = SubmenuBuilder::new(app, "Connections")
                .item(&setup_item)
                .build()?;
            if let Some(menu) = app.menu() {
                menu.append(&connections)?;
            } else {
                app.set_menu(MenuBuilder::new(app).item(&connections).build()?)?;
            }
            let active_ca_setup = Arc::new(AtomicBool::new(false));
            let menu_active = active_ca_setup.clone();
            app.on_menu_event(move |handle, event| {
                if event.id() == setup_item.id() {
                    launch_native_ca_setup(handle.clone(), menu_active.clone());
                }
            });
            let link_handle = app.handle().clone();
            let link_active = active_ca_setup.clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                if urls.iter().any(is_secure_connections_setup_link) {
                    launch_native_ca_setup(link_handle.clone(), link_active.clone());
                }
                for url in urls {
                    launch_browser_access_approval(&url);
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                if urls.iter().any(is_secure_connections_setup_link) {
                    launch_native_ca_setup(app.handle().clone(), active_ca_setup);
                }
                for url in &urls {
                    launch_browser_access_approval(url);
                }
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
            secure_local_connections_status,
            secure_local_connections_setup,
            zone2_status,
            zone2_bootstrap
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mandible app");
}

#[cfg(test)]
mod tests {
    use super::{
        admits_native_command_origin, bind_session_cookie_to_production,
        dashboard_origin_from_cutover, enrollment_daemon_registration_from_journal,
        extract_credential, is_secure_connections_setup_link, read_client_auth_bootstrap,
        resolve_user_path_from, LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN,
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
    fn native_ca_setup_deep_link_has_one_exact_target() {
        assert!(is_secure_connections_setup_link(
            &tauri::Url::parse("mandible://connections/setup").expect("URL")
        ));
        for denied in [
            "mandible://connections/setup?auto=1",
            "mandible://connections/setup/",
            "mandible://connections/status",
            "mandible://preview/connections/setup",
            "https://app.mandible.localhost:19420/connections/setup",
        ] {
            assert!(!is_secure_connections_setup_link(
                &tauri::Url::parse(denied).expect("URL")
            ));
        }
    }

    #[test]
    fn browser_access_link_accepts_only_one_exact_reference() {
        let good = tauri::Url::parse("mandible://access/approve?reference=A1B2C3D4E5F6").unwrap();
        assert_eq!(super::browser_access_reference(&good).as_deref(), Some("A1B2C3D4E5F6"));
        for raw in [
            "mandible://access/approve?reference=A1B2C3D4E5F6&extra=1",
            "mandible://access/approve?reference=A1B2C3D4E5F6#fragment",
            "mandible://other/approve?reference=A1B2C3D4E5F6",
            "mandible://user@access/approve?reference=A1B2C3D4E5F6",
            "mandible://access:123/approve?reference=A1B2C3D4E5F6",
            "mandible://access/approve?reference=short",
            "mandible://access/approve?reference=A1B2C3D4E5FG",
        ] {
            assert!(super::browser_access_reference(&tauri::Url::parse(raw).unwrap()).is_none());
        }
    }

    #[test]
    fn resolves_durable_home_paths() {
        let home = std::path::Path::new("/tmp/home with spaces");
        assert_eq!(resolve_user_path_from("~", home), home);
        assert_eq!(
            resolve_user_path_from("~/tilde-root/", home),
            home.join("tilde-root")
        );
    }

    #[test]
    fn privileged_native_enrollment_is_pinned_to_https_production() {
        assert_eq!(PRODUCTION_ORIGIN, "https://app.mandible.localhost:19420");
        assert!(admits_native_command_origin(PRODUCTION_ORIGIN));
        for denied in [
            "https://preview-0123456789abcdef.mandible.localhost:19421",
            "http://127.0.0.1:19420",
            "http://localhost:19420",
            "http://127.0.0.1:19421",
            "http://localhost:19421",
            "https://app.mandible.localhost:19421",
        ] {
            assert!(
                !admits_native_command_origin(denied),
                "unexpected native admission: {denied}"
            );
        }
    }

    #[test]
    fn desktop_uses_the_old_browser_origin_only_while_conversion_or_rollback_requires_it() {
        let mut journal = serde_json::json!({
            "schema": "mandible-local-session-cutover@1",
            "state": "migration",
            "manifest": {"instances": [{
                "role": "main", "public_port": 19420,
                "candidate": {"instance_id": "production"}
            }]}
        });
        let selected = |value: &serde_json::Value| {
            let raw = serde_json::to_vec(value).expect("journal");
            dashboard_origin_from_cutover(Some(&raw))
        };
        assert_eq!(selected(&journal), LEGACY_PRODUCTION_ORIGIN);
        journal["state"] = "rolled_back".into();
        assert_eq!(selected(&journal), LEGACY_PRODUCTION_ORIGIN);
        journal["state"] = "normal_pending".into();
        assert_eq!(selected(&journal), PRODUCTION_ORIGIN);
        journal["state"] = "complete".into();
        assert_eq!(selected(&journal), PRODUCTION_ORIGIN);
        journal["state"] = "migration".into();
        journal["manifest"]["instances"][0]["candidate"]["instance_id"] = "other".into();
        assert_eq!(selected(&journal), PRODUCTION_ORIGIN);
        assert_eq!(dashboard_origin_from_cutover(None), PRODUCTION_ORIGIN);
        assert_eq!(
            dashboard_origin_from_cutover(Some(b"not json")),
            PRODUCTION_ORIGIN
        );
    }

    #[test]
    fn enrollment_uses_the_unique_registered_production_daemon() {
        let mut journal = serde_json::json!({
            "schema": "mandible-local-session-cutover@1",
            "state": "complete",
            "manifest": {"instances": [{
                "role": "main",
                "candidate": {"instance_id": "production", "process": {"env": {
                    "MANDIBLE_PID_FILE": "/tmp/registered-production.pid",
                    "MANDIBLE_PORT": "29420"
                }}}
            }]}
        });
        let resolve = |value: &serde_json::Value| {
            enrollment_daemon_registration_from_journal(&serde_json::to_vec(value).unwrap())
        };
        assert_eq!(
            resolve(&journal).unwrap(),
            (
                std::path::PathBuf::from("/tmp/registered-production.pid"),
                29420
            )
        );
        journal["manifest"]["instances"][0]["candidate"]["process"]["env"]["MANDIBLE_PID_FILE"] =
            "relative.pid".into();
        assert!(resolve(&journal).is_err());
        journal["manifest"]["instances"][0]["candidate"]["process"]["env"]["MANDIBLE_PID_FILE"] =
            "/tmp/registered-production.pid".into();
        let duplicate = journal["manifest"]["instances"][0].clone();
        journal["manifest"]["instances"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(resolve(&journal).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn daemon_listener_verification_binds_the_pid_to_the_loopback_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(super::registered_pid_owns_listener(std::process::id(), port).unwrap());
        drop(listener);
        assert!(!super::registered_pid_owns_listener(std::process::id(), port).unwrap());
    }

    #[test]
    fn native_session_cookie_is_bound_to_the_exact_production_host() {
        let cookie = tauri::webview::Cookie::parse(
            "__Host-mandible-session=opaque; Path=/; Secure; HttpOnly; SameSite=Strict",
        )
        .unwrap()
        .into_owned();
        let (cookie, url) = bind_session_cookie_to_production(cookie).unwrap();
        assert_eq!(url.as_str(), "https://app.mandible.localhost:19420/");
        assert_eq!(cookie.domain(), Some("app.mandible.localhost"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.http_only(), Some(true));
    }

    #[test]
    fn reads_only_a_protected_bootstrap_token() {
        let path = temp_path("protected");
        fs::write(&path, "desktop-token\n").expect("write bootstrap");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
        }
        assert_eq!(
            read_client_auth_bootstrap(&path).expect("read"),
            Some(b"desktop-token".to_vec())
        );
        fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn rejects_and_scrubs_header_injection_material() {
        let mut poisoned = b"VALID\r\nX-Request-Id: VALID".to_vec();
        let error = extract_credential(&mut poisoned, "keychain").expect_err("poisoned");
        assert!(error.contains("not a valid Mandible token"));
        assert!(!error.contains("VALID"));
        assert!(poisoned.iter().all(|byte| *byte == 0));
    }
}
