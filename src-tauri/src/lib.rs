use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{command, AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
mod canonical_origin;
use canonical_origin::PRODUCTION_ORIGIN;

const DEFAULT_PORT: u16 = 29420;

#[derive(Default)]
struct NativeWindowCapabilityState {
    liquid_glass_clear: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWindowCapabilities {
    liquid_glass_clear: bool,
}

#[command]
fn native_window_capabilities(
    state: tauri::State<'_, NativeWindowCapabilityState>,
) -> NativeWindowCapabilities {
    NativeWindowCapabilities {
        liquid_glass_clear: state.liquid_glass_clear.load(Ordering::Acquire),
    }
}

#[cfg(target_os = "macos")]
fn configure_clear_liquid_glass(window: tauri::WebviewWindow, enabled: Arc<AtomicBool>) {
    let effect_window = window.clone();
    let setup_result = window.with_webview(move |webview| {
        use objc2_app_kit::NSView;
        use window_vibrancy::{
            apply_liquid_glass, clear_liquid_glass, LiquidGlassOptions, NSGlassEffectViewStyle,
        };

        // Put Tauri's webview inside the native glass view. Shared shell
        // surfaces decide which parts of it expose the Clear effect.
        let content_view: &NSView = unsafe { &*webview.inner().cast::<NSView>() };
        let options = LiquidGlassOptions::new(NSGlassEffectViewStyle::Clear)
            .opaque(false)
            .content_view(content_view);

        if let Err(error) = apply_liquid_glass(&effect_window, options) {
            eprintln!("Could not enable native Clear glass: {error}");
            return;
        }

        if let Err(error) =
            effect_window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
        {
            let _ = clear_liquid_glass(&effect_window);
            let _ = effect_window.set_background_color(Some(tauri::window::Color(11, 15, 20, 255)));
            eprintln!("Could not make the native Clear glass backing transparent: {error}");
            return;
        }

        enabled.store(true, Ordering::Release);
    });

    if let Err(error) = setup_result {
        eprintln!("Could not configure native Clear glass: {error}");
    }
}

fn admits_native_command_origin(origin: &str) -> bool {
    origin == PRODUCTION_ORIGIN
}

const DEFAULT_LAUNCH_MODE: &str = "on_demand";
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

fn launch_native_ca_setup(handle: AppHandle, active: Arc<AtomicBool>) {
    if active.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        match run_ca_setup_command(&handle, "setup") {
            Ok(_) => show_native_setup_result(
                &handle,
                "Secure local connections are ready for this Mac account.",
                "You can now open Mandible in this browser.",
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
    let log_file = log_file_path()?;
    let pid_file = pid_file_path()?;
    let (log_stdout, log_stderr) = open_daemon_log(&log_file)?;

    let mut command = Command::new(node);
    command
        .arg(&entry)
        .current_dir(repo_root)
        .env("MANDIBLE_PORT", port.to_string())
        .env("MANDIBLE_PID_FILE", pid_file)
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
    if let Some(pid) = read_pid_file(pid_file_path()?) {
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
    default_mandible_home()
}

fn default_mandible_home() -> PathBuf {
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
    let dashboard_origin = PRODUCTION_ORIGIN;
    let port = daemon_port();
    let pid_file = pid_file_path()?;
    let log_file = log_file_path()?;
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
    // A disposable installation must never read or rewrite the installed
    // app's launch-mode settings under the same bundle identifier.
    if isolated_home_selected() || std::env::var_os("MANDIBLE_CONFIG_DIR").is_some() {
        return Ok(mandible_config_dir().join("desktop.json"));
    }
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

fn pid_file_path() -> Result<PathBuf, String> {
    runtime_file_path(
        std::env::var("MANDIBLE_PID_FILE").ok().as_deref(),
        isolated_home_selected().then(mandible_home),
        "daemon.pid",
    )
}

fn log_file_path() -> Result<PathBuf, String> {
    runtime_file_path(
        std::env::var("MANDIBLE_STDERR_LOG_PATH").ok().as_deref(),
        isolated_home_selected().then(mandible_home),
        "launchd-stderr.log",
    )
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

fn isolated_home_selected() -> bool {
    std::env::var("MANDIBLE_HOME")
        .is_ok_and(|value| !value.trim().is_empty() && mandible_home() != default_mandible_home())
}

fn runtime_file_path(
    explicit: Option<&str>,
    isolated_home: Option<PathBuf>,
    filename: &str,
) -> Result<PathBuf, String> {
    if let Some(value) = explicit {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("{filename} override must be an absolute path"));
        }
        return Ok(path);
    }
    let base = isolated_home.unwrap_or_else(|| {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    });
    Ok(base.join(".cache").join("mandible").join(filename))
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
    let mut context = tauri::generate_context!();
    #[cfg(target_os = "macos")]
    let isolated_store_identifier = isolated_home_selected().then(|| {
        assert!(
            macos_supports_custom_webkit_store(),
            "isolated Mandible desktop requires macOS 14 or newer for a separate WebKit store"
        );
        isolated_webkit_store_identifier(&mandible_home())
    });
    #[cfg(not(target_os = "macos"))]
    let isolated_store_identifier: Option<[u8; 16]> = None;
    let mut isolated_window_labels = Vec::new();
    if isolated_store_identifier.is_some() {
        // Tauri's configured-window conversion in the locked runtime omits
        // data_store_identifier. Defer only these windows so the supported
        // builder method can pass it through to Wry before creation.
        for window in &mut context.config_mut().app.windows {
            if window.create {
                isolated_window_labels.push(window.label.clone());
                window.create = false;
            }
        }
    }
    tauri::Builder::default()
        .manage(NativeWindowCapabilityState::default())
        .plugin(tauri_plugin_deep_link::init())
        .setup(move |app| {
            if let Some(identifier) = isolated_store_identifier {
                for window in app
                    .config()
                    .app
                    .windows
                    .iter()
                    .filter(|window| isolated_window_labels.contains(&window.label))
                {
                    tauri::WebviewWindowBuilder::from_config(app.handle(), window)?
                        .data_store_identifier(identifier)
                        .build()?;
                }
            }
            // Set the window and webview background to match the app's dark theme (#0b0f14).
            // This prevents a white flash in the title-bar area on macOS when using
            // titleBarStyle: "Transparent" — the native window chrome would otherwise
            // default to the system light color before the webview paints.
            // Bug: d41755b — white title bar in Tauri app on macOS
            if let Some(window) = app.get_webview_window("main") {
                let dark = tauri::window::Color(11, 15, 20, 255);
                let _ = window.set_background_color(Some(dark));
                #[cfg(target_os = "macos")]
                configure_clear_liquid_glass(
                    window,
                    app.state::<NativeWindowCapabilityState>()
                        .liquid_glass_clear
                        .clone(),
                );
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
            });
            if let Some(urls) = app.deep_link().get_current()? {
                if urls.iter().any(is_secure_connections_setup_link) {
                    launch_native_ca_setup(app.handle().clone(), active_ca_setup);
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
            secure_local_connections_status,
            secure_local_connections_setup,
            zone2_status,
            zone2_bootstrap,
            native_window_capabilities
        ])
        .run(context)
        .expect("error while running Mandible app");
}

#[cfg(target_os = "macos")]
fn macos_supports_custom_webkit_store() -> bool {
    Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| version.split('.').next()?.parse::<u32>().ok())
        .is_some_and(|major| major >= 14)
}

#[cfg(target_os = "macos")]
fn isolated_webkit_store_identifier(home: &Path) -> [u8; 16] {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(b"mandible-isolated-webkit-store-v1\0");
    digest.update(home.as_os_str().as_encoded_bytes());
    let hash = digest.finalize();
    let mut identifier = [0u8; 16];
    identifier.copy_from_slice(&hash[..16]);
    identifier
}

#[cfg(test)]
mod tests {
    use super::{
        admits_native_command_origin, is_secure_connections_setup_link, resolve_user_path_from,
        PRODUCTION_ORIGIN,
    };
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
    fn resolves_durable_home_paths() {
        let home = std::path::Path::new("/tmp/home with spaces");
        assert_eq!(resolve_user_path_from("~", home), home);
        assert_eq!(
            resolve_user_path_from("~/tilde-root/", home),
            home.join("tilde-root")
        );
    }

    #[test]
    fn privileged_native_setup_is_pinned_to_https_production() {
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
    fn isolated_runtime_paths_never_resolve_to_the_installed_daemon_pid() {
        let isolated = std::path::PathBuf::from("/tmp/mandible-candidate/.mandible");
        let pid = super::runtime_file_path(None, Some(isolated.clone()), "daemon.pid").unwrap();
        let log =
            super::runtime_file_path(None, Some(isolated.clone()), "launchd-stderr.log").unwrap();
        assert_eq!(pid, isolated.join(".cache/mandible/daemon.pid"));
        assert_eq!(log, isolated.join(".cache/mandible/launchd-stderr.log"));
        assert_ne!(
            pid,
            super::runtime_file_path(None, None, "daemon.pid").unwrap()
        );
        assert_eq!(
            super::runtime_file_path(
                Some("/tmp/explicit-candidate.pid"),
                Some(isolated),
                "daemon.pid"
            )
            .unwrap(),
            std::path::PathBuf::from("/tmp/explicit-candidate.pid"),
        );
        assert!(super::runtime_file_path(Some("relative.pid"), None, "daemon.pid").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn isolated_webkit_store_is_stable_per_home() {
        let first = std::path::Path::new("/tmp/mandible-candidate-one");
        let second = std::path::Path::new("/tmp/mandible-candidate-two");
        // This value is durable profile identity; rebuilding must not move its storage.
        assert_eq!(
            super::isolated_webkit_store_identifier(first),
            [144, 63, 64, 251, 110, 109, 174, 172, 226, 170, 98, 98, 182, 233, 54, 66]
        );
        assert_ne!(
            super::isolated_webkit_store_identifier(first),
            super::isolated_webkit_store_identifier(second)
        );
    }
}
