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
/// Fragment parameter the dashboard adopts a session from. Reserved: a route
/// may never carry it, or it would shadow the session injected after it.
const CREDENTIAL_QUERY_PARAM: &str = "mandible_auth";
/// Cap on a handshake response before it is treated as untrustworthy.
const MAX_HANDSHAKE_RESPONSE_BYTES: usize = 64 * 1024;
static CLIENT_AUTH_BOOTSTRAP_CONSUMED: AtomicBool = AtomicBool::new(false);
static CLIENT_AUTH_KEYCHAIN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

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

/// What an enrollment attempt produced. The distinction between a daemon that
/// answered and a daemon that was never reached is load-bearing: only the
/// former means a one-shot bootstrap proof has been spent.
enum Enrollment {
    /// No credential to enroll with — a normal state, not a failure.
    Missing,
    /// A bounded dashboard session, plus the validated route to return to.
    Session { route: String, token: String },
    /// The daemon answered and refused. Any one-shot proof is now spent.
    Refused(String),
    /// The daemon was never reached. A one-shot proof is still good.
    Unreachable(String),
}

/// The fixed order every enrollment follows, so that a request which cannot
/// possibly succeed spends nothing:
///
///   1. validate the caller-supplied route (pure, local),
///   2. run local prechecks (window lookup, same-user daemon verification),
///   3. read and validate the credential,
///   4. exchange it for a bounded dashboard session, scrubbing it afterwards.
///
/// A route rejected in step 1 therefore performs zero keychain reads and zero
/// network calls, and cannot consume a bootstrap proof or mint a new bounded
/// dashboard session. The effects are injected so that ordering is unit-testable
/// without a Tauri app or a daemon.
fn run_enrollment<P, C, E>(
    route: Option<&str>,
    precheck: P,
    read_credential: C,
    exchange: E,
) -> Result<Enrollment, String>
where
    P: FnOnce() -> Result<(), String>,
    C: FnOnce() -> Result<Option<Vec<u8>>, String>,
    E: FnOnce(&[u8]) -> Enrollment,
{
    let route = normalize_enrollment_route(route)?;
    precheck()?;
    let Some(mut credential) = read_credential()? else {
        return Ok(Enrollment::Missing);
    };
    let outcome = exchange(&credential);
    // Best-effort scrub: it narrows the window in which the credential is
    // resident, but cannot undo copies made by the allocator or the pipe.
    credential.fill(0);
    Ok(match outcome {
        Enrollment::Session { token, .. } => Enrollment::Session { route, token },
        other => other,
    })
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
    app.get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    verify_same_user_daemon()
}

/// Navigate the bundled desktop shell to an enrolled dashboard without ever
/// handing the same-user bootstrap proof to the renderer. The shell redeems the
/// proof for a bounded dashboard session itself (see
/// `exchange_credential_for_dashboard_session`) and injects only that session in
/// a URL fragment; fragments are not sent to the daemon and the UI removes it
/// before its first API request.
///
/// The proof file outlives a failed attempt on purpose: it is deleted only once
/// the daemon has actually seen it (redeemed, or refused because a racing
/// surface already spent it). A daemon that is merely unreachable leaves the
/// first-run enrollment window intact and re-arms the attempt guard.
#[command]
fn client_auth_enroll(app: AppHandle) -> Result<bool, String> {
    if CLIENT_AUTH_BOOTSTRAP_CONSUMED.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    let path = client_auth_bootstrap_path();
    // The bootstrap proof authenticates as the operator exactly once, and the
    // handshake is an ordinary authenticated request, so redeeming it here
    // consumes it the same way the dashboard used to.
    let enrollment = run_enrollment(
        None,
        || enrollment_precheck(&app),
        || read_client_auth_bootstrap(&path),
        exchange_credential_for_dashboard_session,
    );
    match enrollment {
        Ok(Enrollment::Session { route, token }) => {
            // The daemon consumed the proof, so the file is stale either way and
            // its removal is never worth failing an issued session over. A
            // removal that fails here self-heals: the next launch reads the
            // stale proof, the daemon refuses it, and the Refused arm retries
            // the deletion.
            discard_spent_proof(&path);
            navigate_to_enrolled_dashboard(&app, &token, &route)?;
            Ok(true)
        }
        Ok(Enrollment::Missing) => Ok(false),
        Ok(Enrollment::Refused(message)) => {
            // A racing surface already spent the proof: the file is dead, and
            // deleting it is what stops this failure from repeating on every
            // launch. Same self-healing retry if the removal itself fails.
            discard_spent_proof(&path);
            Err(message)
        }
        Ok(Enrollment::Unreachable(message)) => {
            CLIENT_AUTH_BOOTSTRAP_CONSUMED.store(false, Ordering::Release);
            Err(message)
        }
        Err(message) => {
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
/// bounded dashboard session, scrubbed, and only that session is injected into
/// the webview. That containment is what makes the command safe to expose to
/// renderer JavaScript at all: the dashboard origin is a Tauri-capable remote
/// origin, so dashboard script (including injected script after an XSS) can
/// invoke this command. What it can obtain is therefore at most a bounded
/// operator dashboard session — the credential it already holds — and the
/// residual abuse is bounded-session minting by already-authorized dashboard
/// script. Independent dashboard sessions may coexist; this command neither
/// names nor selects another surface. It can never read the durable keychain
/// token.
///
/// `Ok(false)` means "nothing to enroll from" (no keychain item, or another
/// keychain attempt is already in flight) — a normal state, not a failure.
///
/// Enrollment is attempted only when this webview has no working session of its
/// own, or when the operator explicitly retries after an honest failure. The
/// server contract may keep independent bounded dashboard sessions; this bridge
/// deliberately supplies no surface identity and assumes no rotation policy.
#[command]
fn client_auth_keychain_enroll(app: AppHandle, route: Option<String>) -> Result<bool, String> {
    // Rust prevents concurrent reads/exchanges but does not accept renderer
    // retry policy as an argument. The UI owns its one-attempt-per-episode state
    // machine; releasing this guard after every result lets a later genuine 401
    // recover without restarting the app.
    if CLIENT_AUTH_KEYCHAIN_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }
    let enrollment = run_enrollment(
        route.as_deref(),
        || enrollment_precheck(&app),
        || read_keychain_operator_token(KEYCHAIN_OPERATOR_SERVICE),
        exchange_credential_for_dashboard_session,
    );
    let result = match enrollment {
        Ok(Enrollment::Session { route, token }) => {
            navigate_to_enrolled_dashboard(&app, &token, &route).map(|()| true)
        }
        Ok(Enrollment::Missing) => Ok(false),
        Ok(Enrollment::Refused(message)) => Err(message),
        Ok(Enrollment::Unreachable(message)) | Err(message) => Err(message),
    };
    CLIENT_AUTH_KEYCHAIN_IN_FLIGHT.store(false, Ordering::Release);
    result
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

/// Redeem a durable operator credential for a bounded dashboard session by
/// performing the dashboard's own handshake here, so the renderer only ever
/// sees the expiring session token.
///
/// The daemon speaks plain HTTP on loopback and already writes `Content-Length`
/// with `Connection: close`, so this uses the same dependency-free `TcpStream`
/// request style as `zone2_bootstrap` rather than adding an HTTP client crate.
fn exchange_credential_for_dashboard_session(credential: &[u8]) -> Enrollment {
    // Defence in depth. The credential was validated at read time; refuse to
    // build a request at all from bytes that could smuggle a header.
    if !is_credential_material(credential) {
        return Enrollment::Unreachable(
            "refusing to send a malformed operator credential".to_string(),
        );
    }
    let port = daemon_port();
    let addr = match format!("127.0.0.1:{port}")
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
    {
        Some(addr) => addr,
        None => {
            return Enrollment::Unreachable("failed to resolve the daemon address".to_string());
        }
    };

    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(2000)) {
        Ok(stream) => stream,
        Err(error) => {
            return Enrollment::Unreachable(format!(
                "failed to reach the daemon for enrollment: {error}"
            ));
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut request = build_handshake_request(credential, port);
    let sent = stream.write_all(&request);
    // The request buffer is the only other place the credential is materialized.
    request.fill(0);
    if let Err(error) = sent {
        return Enrollment::Unreachable(format!(
            "failed to send the enrollment handshake: {error}"
        ));
    }

    // Bounded read: a hostile or broken listener must not be able to make the
    // shell buffer without limit. One byte past the cap detects overflow.
    let mut response = Vec::with_capacity(1024);
    if let Err(error) = stream
        .take((MAX_HANDSHAKE_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
    {
        return Enrollment::Unreachable(format!(
            "failed to read the enrollment handshake response: {error}"
        ));
    }
    interpret_handshake_response(&response)
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

/// Turn raw handshake response bytes into an enrollment outcome.
///
/// Anything that leaves real doubt about whether the daemon processed the
/// credential — an oversized, unparseable, or truncated response — is reported
/// as `Unreachable`, which is the conservative classification: it preserves a
/// one-shot bootstrap proof rather than deleting one that may still be live.
/// Failures report the status only; a rejected credential is never echoed back.
fn interpret_handshake_response(response: &[u8]) -> Enrollment {
    if response.len() > MAX_HANDSHAKE_RESPONSE_BYTES {
        return Enrollment::Unreachable(
            "the daemon returned an oversized enrollment response".to_string(),
        );
    }
    let malformed = || {
        Enrollment::Unreachable("the daemon returned a malformed enrollment response".to_string())
    };
    let response = String::from_utf8_lossy(response);
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return malformed();
    };
    let Some(status) = parse_status_line(head.lines().next().unwrap_or_default()) else {
        return malformed();
    };
    let framing = declared_content_length(head);
    if let ContentLength::Declared(expected) = framing {
        if body.len() != expected {
            return Enrollment::Unreachable(
                "the daemon returned a truncated enrollment response".to_string(),
            );
        }
    }
    if !(200..300).contains(&status) {
        return Enrollment::Refused(match status {
            401 | 403 => "the stored operator credential was rejected by the daemon".to_string(),
            409 => "no operator is configured; run `mandible user setup` first".to_string(),
            other => format!("the daemon refused the enrollment handshake (HTTP {other})"),
        });
    }
    // A success must be fully framed. The daemon always writes Content-Length
    // alongside Connection: close, so a 2xx without a parseable one is either
    // not the daemon or a body we cannot prove is complete — and an incomplete
    // body could still parse as JSON with a partial token.
    if !matches!(framing, ContentLength::Declared(_)) {
        return Enrollment::Unreachable(
            "the daemon returned an unframed enrollment response".to_string(),
        );
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return Enrollment::Refused(
            "the daemon returned an unreadable enrollment response".to_string(),
        );
    };
    match parsed.get("token").and_then(serde_json::Value::as_str) {
        Some(token) if !token.is_empty() => Enrollment::Session {
            route: String::new(),
            token: token.to_string(),
        },
        _ => Enrollment::Refused("the daemon returned no dashboard session".to_string()),
    }
}

/// Accept only a strict `HTTP/1.x <3-digit>` status line, so a listener that is
/// not the daemon cannot be read as a successful handshake.
fn parse_status_line(line: &str) -> Option<u16> {
    let mut rest = line.strip_prefix("HTTP/1.")?.chars();
    if !rest.next()?.is_ascii_digit() || rest.next()? != ' ' {
        return None;
    }
    let code: String = rest.by_ref().take(3).collect();
    if code.len() != 3 || !code.chars().all(|value| value.is_ascii_digit()) {
        return None;
    }
    match rest.next() {
        None | Some(' ') => code.parse().ok(),
        _ => None,
    }
}

/// How a response framed its body. `Absent` and `Invalid` are kept distinct
/// from `Declared` because a successful handshake must be positively framed;
/// silently treating an unparseable header as "no header" would reopen the
/// gap it is there to close.
enum ContentLength {
    Absent,
    Invalid,
    Declared(usize),
}

fn declared_content_length(head: &str) -> ContentLength {
    let mut declared: Option<usize> = None;
    for line in head.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("content-length") {
            continue;
        }
        let Ok(length) = value.trim().parse::<usize>() else {
            return ContentLength::Invalid;
        };
        // Conflicting repeats are a framing-confusion signature, never the
        // daemon's own single-header response.
        if declared.is_some_and(|previous| previous != length) {
            return ContentLength::Invalid;
        }
        declared = Some(length);
    }
    declared.map_or(ContentLength::Absent, ContentLength::Declared)
}

/// Both enrollment paths carry the bounded session token in a URL fragment, so
/// it must be fragment-safe before it is spliced into the navigation URL. This
/// is the same allowlist that gates what may be sent as a bearer credential.
fn is_url_fragment_safe(value: &str) -> bool {
    is_credential_material(value.as_bytes())
}

/// Keep the dashboard on the operator's current view across enrollment instead
/// of resetting it to the default route. The route is caller-supplied, so it is
/// restricted to characters that stay inside the fragment; the loopback origin
/// and path are fixed here and can never be moved by the caller.
///
/// A route whose query already carries a `mandible_auth` key is refused: the
/// dashboard reads the first occurrence, so a forwarded stale value would
/// shadow the session injected after it and strand a credential in the visible
/// URL. The check is structural — keys are split out and percent-decoded the
/// way `URLSearchParams` decodes them — so neither `%5F` nor any other encoding
/// slips through, and an ordinary route like `/search?q=mandible_authentication`
/// is not caught by an over-broad substring match.
fn normalize_enrollment_route(route: Option<&str>) -> Result<String, String> {
    let route = route.map(str::trim).unwrap_or_default();
    if route.is_empty() {
        return Ok("/".to_string());
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
    if let Some((_, query)) = route.split_once('?') {
        let reserved = query
            .split('&')
            .map(|pair| pair.split('=').next().unwrap_or_default())
            .any(|key| percent_decode_ascii(key).eq_ignore_ascii_case(CREDENTIAL_QUERY_PARAM));
        if reserved {
            return Err("desktop enrollment route may not carry a mandible_auth value".to_string());
        }
    }
    Ok(route.to_string())
}

/// Decode `%XX` escapes the way a query-string parser does, so a reserved key
/// cannot hide behind an encoding. Invalid escapes are left literal, matching
/// `URLSearchParams` leniency.
fn percent_decode_ascii(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Some(byte) = decode_hex_pair(bytes[index + 1], bytes[index + 2]) {
                decoded.push(byte as char);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index] as char);
        index += 1;
    }
    decoded
}

fn decode_hex_pair(high: u8, low: u8) -> Option<u8> {
    let nibble = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    Some(nibble(high)? * 16 + nibble(low)?)
}

/// Navigate to the enrolled dashboard. `route` is already normalized by
/// `run_enrollment`, so this only guards the injected session token.
fn navigate_to_enrolled_dashboard(app: &AppHandle, token: &str, route: &str) -> Result<(), String> {
    if !is_url_fragment_safe(token) {
        return Err("client-auth credential contains invalid URL-fragment characters".to_string());
    }
    let separator = if route.contains('?') { '&' } else { '?' };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    let url = format!(
        "http://127.0.0.1:{}/#{route}{separator}{CREDENTIAL_QUERY_PARAM}={token}",
        daemon_port()
    );
    let encoded = serde_json::to_string(&url)
        .map_err(|error| format!("failed to encode dashboard enrollment URL: {error}"))?;
    window
        .eval(&format!("window.location.replace({encoded});"))
        .map_err(|error| format!("failed to navigate to enrolled dashboard: {error}"))
}

fn verify_same_user_daemon() -> Result<(), String> {
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
        build_handshake_request, extract_credential, interpret_handshake_response,
        is_url_fragment_safe, normalize_enrollment_route, read_client_auth_bootstrap,
        run_enrollment, Enrollment, MAX_HANDSHAKE_RESPONSE_BYTES,
    };
    use std::cell::Cell;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn session_token(enrollment: Enrollment) -> Option<String> {
        match enrollment {
            Enrollment::Session { token, .. } => Some(token),
            _ => None,
        }
    }

    fn failure_message(enrollment: &Enrollment) -> String {
        match enrollment {
            Enrollment::Refused(message) | Enrollment::Unreachable(message) => message.clone(),
            _ => panic!("expected a failed enrollment"),
        }
    }

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
            Some(b"desktop-token".to_vec()),
        );
        fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn refuses_a_bootstrap_file_that_is_not_a_token() {
        let path = temp_path("poisoned");
        fs::write(&path, "VALID\r\nX-Request-Id: VALID\n").expect("write bootstrap");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
        }
        let error = read_client_auth_bootstrap(&path).expect_err("poisoned bootstrap");
        assert!(error.contains("not a valid Mandible token"));
        // The rejection must not quote the value it refused.
        assert!(!error.contains("VALID"));
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
        assert!(normalize_enrollment_route(Some("/issues?repo=x&mandible_auth=stolen")).is_err());
        // Percent-encoded spellings decode to the same key in the dashboard.
        assert!(normalize_enrollment_route(Some("/issues?mandible%5Fauth=stolen")).is_err());
        assert!(normalize_enrollment_route(Some("/issues?mandible%5fauth=stolen")).is_err());
        assert!(normalize_enrollment_route(Some("/issues?%6Dandible_auth=stolen")).is_err());
        // Matching is structural, so ordinary keys, values, and paths survive.
        assert!(normalize_enrollment_route(Some("/search?q=mandible_authentication")).is_ok());
        assert!(normalize_enrollment_route(Some("/mandible_auth")).is_ok());
        assert!(normalize_enrollment_route(Some("/issues?repo=mandible")).is_ok());
    }

    #[test]
    fn validates_the_route_before_reading_or_sending_any_credential() {
        let read = Cell::new(false);
        let exchanged = Cell::new(false);
        let prechecked = Cell::new(false);

        let rejected = run_enrollment(
            Some("/issues?mandible%5Fauth=stolen"),
            || {
                prechecked.set(true);
                Ok(())
            },
            || {
                read.set(true);
                Ok(Some(b"mandible_pat_secret".to_vec()))
            },
            |_| {
                exchanged.set(true);
                Enrollment::Session {
                    route: String::new(),
                    token: "dashboard-session".to_string(),
                }
            },
        );

        assert!(rejected.is_err());
        // A rejected route spends nothing: no daemon probe, no keychain read,
        // no handshake, so no one-shot proof and no bounded session is lost.
        assert!(!prechecked.get());
        assert!(!read.get());
        assert!(!exchanged.get());
    }

    #[test]
    fn carries_the_validated_route_alongside_the_issued_session() {
        let enrollment = run_enrollment(
            Some("/issues?repo=mandible"),
            || Ok(()),
            || Ok(Some(b"mandible_pat_secret".to_vec())),
            |credential| {
                assert_eq!(credential, b"mandible_pat_secret");
                Enrollment::Session {
                    route: String::new(),
                    token: "dashboard-session".to_string(),
                }
            },
        )
        .expect("enrollment");
        match enrollment {
            Enrollment::Session { route, token } => {
                assert_eq!(route, "/issues?repo=mandible");
                assert_eq!(token, "dashboard-session");
            }
            _ => panic!("expected a session"),
        }
    }

    #[test]
    fn treats_an_absent_credential_as_nothing_to_enroll() {
        let exchanged = Cell::new(false);
        let enrollment = run_enrollment(
            None,
            || Ok(()),
            || Ok(None),
            |_| {
                exchanged.set(true);
                Enrollment::Unreachable("unused".to_string())
            },
        )
        .expect("enrollment");
        assert!(matches!(enrollment, Enrollment::Missing));
        assert!(!exchanged.get());
    }

    #[test]
    fn never_sends_a_credential_that_failed_validation() {
        let exchanged = Cell::new(false);
        let result = run_enrollment(
            None,
            || Ok(()),
            || Err("the keychain operator credential is not a valid Mandible token".to_string()),
            |_| {
                exchanged.set(true);
                Enrollment::Unreachable("unused".to_string())
            },
        );
        assert!(result.is_err());
        assert!(!exchanged.get());
    }

    #[test]
    fn trims_validates_and_scrubs_a_credential_buffer() {
        let mut raw = b"  mandible_pat_abc-123~. \n".to_vec();
        let credential = extract_credential(&mut raw, "keychain")
            .expect("valid credential")
            .expect("present");
        assert_eq!(credential, b"mandible_pat_abc-123~.".to_vec());
        // The whole source buffer is scrubbed, not just the trimmed span.
        assert!(raw.iter().all(|byte| *byte == 0));

        // A CR/LF-bearing value would smuggle headers into the handshake; it is
        // refused at read time, before any connection is opened.
        let mut poisoned = b"VALID\r\nX-Request-Id: VALID".to_vec();
        let error = extract_credential(&mut poisoned, "keychain").expect_err("poisoned");
        assert!(error.contains("not a valid Mandible token"));
        assert!(!error.contains("VALID"));
        assert!(poisoned.iter().all(|byte| *byte == 0));

        let mut blank = b"   \n".to_vec();
        assert!(extract_credential(&mut blank, "keychain")
            .expect("blank credential")
            .is_none());
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
        let body = "{\"token\":\"dashboard-session\",\"expires_at\":1,\"user\":{\"slug\":\"op\"}}";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len(),
        );
        assert_eq!(
            session_token(interpret_handshake_response(response.as_bytes())),
            Some("dashboard-session".to_string()),
        );
    }

    #[test]
    fn reports_handshake_failures_without_echoing_the_credential() {
        // A daemon that answered has seen the credential: a one-shot proof is
        // spent, so these are Refused rather than Unreachable.
        let rejected =
            interpret_handshake_response(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        assert!(matches!(rejected, Enrollment::Refused(_)));
        let message = failure_message(&rejected);
        assert!(message.contains("rejected by the daemon"));

        let unconfigured =
            interpret_handshake_response(b"HTTP/1.1 409 Conflict\r\nContent-Length: 2\r\n\r\n{}");
        assert!(failure_message(&unconfigured).contains("mandible user setup"));

        assert!(matches!(
            interpret_handshake_response(b"HTTP/1.1 500 Server Error\r\n\r\n"),
            Enrollment::Refused(_)
        ));
        // A 200 without a usable token is a failure, never an empty enrollment.
        assert!(matches!(
            interpret_handshake_response(
                b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n{\"token\":\"\"}"
            ),
            Enrollment::Refused(_)
        ));
    }

    #[test]
    fn requires_a_success_to_declare_its_own_framing() {
        let body = "{\"token\":\"dashboard-session\"}";
        // Without a length there is nothing proving the body is complete, and a
        // truncated body can still parse as JSON with a partial token.
        let unframed = interpret_handshake_response(
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{body}").as_bytes(),
        );
        assert!(matches!(unframed, Enrollment::Unreachable(_)));
        assert!(failure_message(&unframed).contains("unframed"));

        for header in [
            "Content-Length: abc",
            "Content-Length:",
            "Content-Length: -1",
        ] {
            assert!(
                matches!(
                    interpret_handshake_response(
                        format!("HTTP/1.1 200 OK\r\n{header}\r\n\r\n{body}").as_bytes()
                    ),
                    Enrollment::Unreachable(_)
                ),
                "expected {header} to be untrusted framing",
            );
        }

        // Conflicting repeats are framing confusion, not a usable length.
        assert!(matches!(
            interpret_handshake_response(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Length: 4\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes()
            ),
            Enrollment::Unreachable(_)
        ));

        // The matching declaration still succeeds, repeated or not.
        assert_eq!(
            session_token(interpret_handshake_response(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes()
            )),
            Some("dashboard-session".to_string()),
        );
    }

    #[test]
    fn refuses_responses_that_cannot_be_trusted_as_the_daemons() {
        // Everything here leaves doubt about whether the credential was seen,
        // so it must classify as Unreachable and preserve a one-shot proof.
        let oversized = vec![b'x'; MAX_HANDSHAKE_RESPONSE_BYTES + 1];
        assert!(matches!(
            interpret_handshake_response(&oversized),
            Enrollment::Unreachable(_)
        ));

        let truncated = interpret_handshake_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n{\"token\":\"short\"}",
        );
        assert!(matches!(truncated, Enrollment::Unreachable(_)));
        assert!(failure_message(&truncated).contains("truncated"));

        for garbage in [
            &b"not http at all\r\n\r\n{}"[..],
            &b"HTTP/2 200 OK\r\n\r\n{}"[..],
            &b"HTTP/1.1 20 OK\r\n\r\n{}"[..],
            &b"HTTP/1.1 2000 OK\r\n\r\n{}"[..],
            &b"HTTP/1.1 OK\r\n\r\n{}"[..],
            &b"HTTP/1.1 200 OK"[..],
        ] {
            assert!(
                matches!(
                    interpret_handshake_response(garbage),
                    Enrollment::Unreachable(_)
                ),
                "expected an untrusted classification",
            );
        }
    }
}
