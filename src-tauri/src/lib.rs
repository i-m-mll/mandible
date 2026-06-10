use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

const DEFAULT_PORT: u16 = 19420;
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
            zone2_status,
            zone2_bootstrap
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mandible app");
}
