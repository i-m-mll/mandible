use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::PageLoadEvent;
use tauri::{command, AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
mod acceptance;
mod native_preview;

#[derive(Clone, Default)]
struct NativeLaunchContext(Option<native_preview::NativePreview>);

fn require_production_context(app: &AppHandle) -> Result<(), String> {
    if app.state::<NativeLaunchContext>().0.is_some() {
        return Err("Production native operations are unavailable in a native preview".into());
    }
    Ok(())
}
mod canonical_origin;
mod native_frame;
use canonical_origin::PRODUCTION_ORIGIN;

#[derive(Default)]
struct NativeWindowCapabilityState {
    liquid_glass_regular: Arc<AtomicBool>,
    frame: Arc<Mutex<native_frame::FrameState>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWindowCapabilities {
    liquid_glass_regular: bool,
    frame_presentation: &'static str,
    top_bar_height: f64,
    traffic_light_reservation: f64,
    traffic_light_bounds: Option<native_frame::Rect>,
    native_frame: Option<serde_json::Value>,
}

#[command]
async fn native_window_capabilities(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeWindowCapabilityState>,
    dom_frame: Option<native_frame::DomFrame>,
) -> Result<NativeWindowCapabilities, String> {
    #[cfg(target_os = "macos")]
    let observed = Some(native_frame::observe(window, state.frame.clone(), dom_frame).await?);
    #[cfg(not(target_os = "macos"))]
    let observed: Option<native_frame::Observation> = {
        let _ = (window, dom_frame);
        None
    };
    let applied = state
        .frame
        .lock()
        .expect("native frame lock poisoned")
        .applied;
    Ok(NativeWindowCapabilities {
        liquid_glass_regular: state.liquid_glass_regular.load(Ordering::Acquire),
        frame_presentation: native_frame::presentation(),
        top_bar_height: native_frame::HEADER_HEIGHT,
        traffic_light_reservation: if observed.as_ref().is_some_and(|frame| frame.fullscreen) {
            0.0
        } else {
            applied.map_or(0.0, |layout| layout.reservation)
        },
        traffic_light_bounds: observed.as_ref().map(|observed| observed.bounds),
        native_frame: observed.map(|observed| observed.snapshot),
    })
}

#[cfg(target_os = "macos")]
fn configure_regular_liquid_glass(window: tauri::WebviewWindow, enabled: Arc<AtomicBool>) {
    use window_vibrancy::{
        apply_liquid_glass, clear_liquid_glass, LiquidGlassOptions, NSGlassEffectViewStyle,
    };

    let glass_applied = Arc::new(AtomicBool::new(false));
    let callback_glass_applied = glass_applied.clone();
    let effect_window = window.clone();
    // Called from Builder::setup on the macOS main thread. The locked Wry
    // runtime handles same-thread with_webview messages synchronously, so the
    // callback has returned before this function continues. Keep Tauri window
    // dispatches below, outside the callback, to avoid re-entering its lock.
    let setup_result = window.with_webview(move |webview| {
        use objc2_app_kit::NSView;

        // Put Tauri's webview inside the native glass view. Shared shell
        // surfaces decide which parts of it expose the Regular effect.
        let content_view: &NSView = unsafe { &*webview.inner().cast::<NSView>() };
        let options = LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular)
            .opaque(false)
            .content_view(content_view);

        if let Err(error) = apply_liquid_glass(&effect_window, options) {
            eprintln!("Could not enable native Regular glass: {error}");
        } else {
            callback_glass_applied.store(true, Ordering::Release);
        }
    });

    if let Err(error) = setup_result {
        eprintln!("Could not configure native Regular glass: {error}");
        if glass_applied.load(Ordering::Acquire) {
            if let Err(clear_error) = clear_liquid_glass(&window) {
                eprintln!(
                    "Could not clear native Regular glass after setup failure: {clear_error}"
                );
            }
        }
        restore_dark_window_background(&window);
        return;
    }

    if !glass_applied.load(Ordering::Acquire) {
        restore_dark_window_background(&window);
        return;
    }

    if let Err(error) = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0))) {
        if let Err(clear_error) = clear_liquid_glass(&window) {
            eprintln!("Could not clear native Regular glass after backing failure: {clear_error}");
        }
        restore_dark_window_background(&window);
        eprintln!("Could not make the native Regular glass backing transparent: {error}");
        return;
    }

    enabled.store(true, Ordering::Release);
}

#[cfg(target_os = "macos")]
fn restore_dark_window_background(window: &tauri::WebviewWindow) {
    if let Err(error) = window.set_background_color(Some(tauri::window::Color(11, 15, 20, 255))) {
        eprintln!("Could not restore the dark native window background: {error}");
    }
}

const RUNTIME_COMMAND_TIMEOUT: Duration = Duration::from_secs(40);
const DASHBOARD_NAVIGATION_TIMEOUT: Duration = Duration::from_secs(12);

struct PendingDashboardNavigation {
    id: u64,
    origin: String,
    started: bool,
    completion: Sender<()>,
}

static DASHBOARD_NAVIGATION: Mutex<Option<PendingDashboardNavigation>> = Mutex::new(None);
static NEXT_DASHBOARD_NAVIGATION_ID: AtomicU64 = AtomicU64::new(1);

fn is_dashboard_origin(url: &tauri::Url) -> bool {
    url.origin().ascii_serialization() == PRODUCTION_ORIGIN
}

fn note_dashboard_page_load(label: &str, url: &tauri::Url, event: PageLoadEvent) {
    if label != "main" || !is_dashboard_origin(url) {
        return;
    }
    let mut pending = DASHBOARD_NAVIGATION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(pending) = pending.as_mut() {
        if pending.origin != url.origin().ascii_serialization() {
            return;
        }
        match event {
            PageLoadEvent::Started => pending.started = true,
            PageLoadEvent::Finished if pending.started => {
                let _ = pending.completion.send(());
            }
            PageLoadEvent::Finished => {}
        }
    }
}

fn return_to_bootstrap_after_navigation_failure(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(mut url) = tauri::Url::parse("tauri://localhost/index.html") {
            url.set_query(Some("skip_autostart=1&dashboard_navigation_failed=1"));
            let _ = window.navigate(url);
        }
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

#[derive(Clone, Debug, Serialize, Deserialize)]
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
    dashboard_ready: bool,
    dashboard_origin: String,
    gateway_state: String,
    gateway_error: Option<String>,
    gateway_log_file: String,
}

static DAEMON_CONTROL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct SecureLocalConnectionsStatus {
    state: String,
    storage_root: String,
    root_digest: Option<String>,
    verified_at: Option<String>,
}

fn installed_resources(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    if resources.join("release.json").is_file() { return Ok(Some(resources)); }
    if cfg!(debug_assertions) { return Ok(None); }
    Err("Mandible's installed release manifest is missing".into())
}

fn installed_resource(root: &Path, section: &str, key: &str) -> Result<PathBuf, String> {
    let bytes = std::fs::read(root.join("release.json")).map_err(|e| e.to_string())?;
    let release: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if release["schema"] != "mandible-installed-release@1" { return Err("Unsupported installed release".into()); }
    let relative = release[section][key].as_str().ok_or("Installed resource is not declared")?;
    if Path::new(relative).is_absolute() { return Err("Installed resource path must be relative".into()); }
    let file = root.join(relative).canonicalize().map_err(|e| format!("Missing installed resource {key}: {e}"))?;
    let contents = root.parent().ok_or("Installed resource root has no program directory")?.canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(contents) || !file.is_file() { return Err("Installed resource leaves the application".into()); }
    Ok(file)
}

fn resolve_ca_setup_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = installed_resources(app)? { return installed_resource(&root, "entrypoints", "trustSetup"); }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/local-ca-trust.mjs"))
}

fn run_ca_setup_command(
    app: &AppHandle,
    command_name: &str,
) -> Result<SecureLocalConnectionsStatus, String> {
    require_production_context(app)?;
    let script = resolve_ca_setup_script(app)?;
    let output = runtime_command(app)?
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
    if let Some(root) = installed_resources(app)? { return installed_resource(&root, "native", "trustHelper"); }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/local-ca-trust-helper"))
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
    let config = read_desktop_config(&app)?;
    run_local_runtime(&app, "status", &config)
}

#[command]
fn daemon_get_launch_mode(app: AppHandle) -> Result<String, String> {
    Ok(read_desktop_config(&app)?.daemon_launch_mode)
}

#[command]
fn daemon_set_launch_mode(app: AppHandle, launch_mode: String) -> Result<DaemonStatus, String> {
    validate_launch_mode(&launch_mode)?;
    let mut config = read_desktop_config(&app)?;
    config.daemon_launch_mode = launch_mode;
    write_desktop_config(&app, &config)?;
    run_local_runtime(&app, "configure-launch-mode", &config)
}

#[command]
fn daemon_start(app: AppHandle) -> Result<DaemonStatus, String> {
    let _guard = DAEMON_CONTROL_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let config = read_desktop_config(&app)?;
    run_local_runtime(&app, "start", &config)
}

#[command]
fn daemon_stop(app: AppHandle) -> Result<DaemonStatus, String> {
    let _guard = DAEMON_CONTROL_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let config = read_desktop_config(&app)?;
    run_local_runtime(&app, "stop", &config)
}

#[command]
fn daemon_restart(app: AppHandle) -> Result<DaemonStatus, String> {
    let _guard = DAEMON_CONTROL_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let config = read_desktop_config(&app)?;
    run_local_runtime(&app, "restart", &config)
}

#[command]
fn navigate_to_desktop_bootstrap(app: AppHandle, skip_auto_start: bool) -> Result<(), String> {
    require_production_context(&app)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    let mut url = tauri::Url::parse("tauri://localhost/index.html")
        .map_err(|error| format!("failed to resolve the desktop bootstrap URL: {error}"))?;
    if skip_auto_start {
        url.set_query(Some("skip_autostart=1"));
    }
    window
        .navigate(url)
        .map_err(|error| format!("failed to navigate to the desktop bootstrap: {error}"))
}

#[command]
async fn navigate_to_desktop_dashboard(app: AppHandle) -> Result<(), String> {
    let status = run_local_runtime(&app, "status", &read_desktop_config(&app)?)?;
    if !status.dashboard_ready || !admits_native_command_origin(&status.dashboard_origin) {
        return Err(status
            .detail
            .unwrap_or_else(|| "The trusted local dashboard is not ready.".to_string()));
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "desktop main window is unavailable".to_string())?;
    let url = tauri::Url::parse(PRODUCTION_ORIGIN)
        .map_err(|error| format!("invalid canonical dashboard origin: {error}"))?;
    let operation_id = NEXT_DASHBOARD_NAVIGATION_ID.fetch_add(1, Ordering::Relaxed);
    let (completion, completed) = mpsc::channel();
    {
        let mut pending = DASHBOARD_NAVIGATION
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending.is_some() {
            return Err("a dashboard navigation is already in progress".to_string());
        }
        *pending = Some(PendingDashboardNavigation {
            id: operation_id,
            origin: url.origin().ascii_serialization(),
            started: false,
            completion,
        });
    }
    if let Err(error) = window.navigate(url) {
        clear_dashboard_navigation(operation_id);
        return_to_bootstrap_after_navigation_failure(&app);
        return Err(format!(
            "failed to navigate to the trusted dashboard: {error}"
        ));
    }

    let waited = tauri::async_runtime::spawn_blocking(move || {
        completed.recv_timeout(DASHBOARD_NAVIGATION_TIMEOUT)
    })
    .await;
    clear_dashboard_navigation(operation_id);
    let wait = waited.map_err(|error| format!("dashboard navigation monitor failed: {error}"))?;
    match wait {
        Ok(()) => Ok(()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return_to_bootstrap_after_navigation_failure(&app);
            Err(format!(
                "the trusted dashboard did not finish loading within {} seconds",
                DASHBOARD_NAVIGATION_TIMEOUT.as_secs()
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return_to_bootstrap_after_navigation_failure(&app);
            Err("the dashboard navigation completion monitor closed unexpectedly".to_string())
        }
    }
}

fn clear_dashboard_navigation(operation_id: u64) {
    let mut pending = DASHBOARD_NAVIGATION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if pending
        .as_ref()
        .is_some_and(|operation| operation.id == operation_id)
    {
        *pending = None;
    }
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

fn run_local_runtime(
    app: &AppHandle,
    operation: &str,
    config: &DesktopConfig,
) -> Result<DaemonStatus, String> {
    require_production_context(app)?;
    let script = resolve_local_runtime_script(app)?;
    let working_directory = resolve_runtime_controller_working_directory(&script)?;
    let mut child = runtime_command(app)?
        .arg(script)
        .arg(operation)
        .arg(format!("--launch-mode={}", config.daemon_launch_mode))
        .current_dir(working_directory)
        .env("MANDIBLE_HOME", mandible_home())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start the Mandible runtime controller: {error}"))?;
    let deadline = Instant::now() + RUNTIME_COMMAND_TIMEOUT;
    let exit = loop {
        match child.try_wait().map_err(|error| {
            format!("failed to inspect the Mandible runtime controller: {error}")
        })? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Mandible runtime operation '{operation}' exceeded its {} second deadline.",
                    RUNTIME_COMMAND_TIMEOUT.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut stream) = child.stdout.take() {
        stream
            .read_to_string(&mut stdout)
            .map_err(|error| format!("failed to read runtime status: {error}"))?;
    }
    if let Some(mut stream) = child.stderr.take() {
        stream
            .read_to_string(&mut stderr)
            .map_err(|error| format!("failed to read runtime error: {error}"))?;
    }
    if !exit.success() {
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Mandible runtime operation '{operation}' failed with {exit}.")
        } else {
            detail.to_string()
        });
    }
    let mut status: DaemonStatus = serde_json::from_str(&stdout)
        .map_err(|error| format!("Mandible runtime controller returned invalid status: {error}"))?;
    status.launch_mode = config.daemon_launch_mode.clone();
    Ok(status)
}

fn resolve_local_runtime_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = installed_resources(app)? { return installed_resource(&root, "entrypoints", "controller"); }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/local-runtime.mjs"))
}

fn read_desktop_config(app: &AppHandle) -> Result<DesktopConfig, String> {
    require_production_context(app)?;
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

fn resolve_runtime_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = installed_resources(app)? { return installed_resource(&root, "native", "bun"); }
    let selector = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/bun-runtime.sh");
    let output = Command::new("/bin/sh").arg(selector).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned()); }
    Ok(PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

fn runtime_command(app: &AppHandle) -> Result<Command, String> {
    let mut command = Command::new(resolve_runtime_binary(app)?);
    if let Some(root) = installed_resources(app)? {
        command.env("MANDIBLE_RELEASE_ROOT", &root);
        command.env("MANDIBLE_RUNTIME", installed_resource(&root, "native", "bun")?);
        command.env("MANDIBLE_SQLITE_LIBRARY", installed_resource(&root, "native", "sqlite")?);
        command.env("MANDIBLE_CADDY", installed_resource(&root, "native", "caddy")?);
        command.env("MANDIBLE_CA_TRUST_HELPER", installed_resource(&root, "native", "trustHelper")?);
        command.env_remove("MANDIBLE_SQLITE_LIBRARY_ARCHIVE");
        command.env_remove("MANDIBLE_RUNTIME_ARCHIVE");
    }
    Ok(command)
}

fn resolve_runtime_controller_working_directory(script: &Path) -> Result<PathBuf, String> {
    let managed_runtime = mandible_home().join("config").join("local-sessions");
    if managed_runtime.is_dir() {
        return Ok(managed_runtime);
    }

    script
        .parent()
        .filter(|directory| directory.is_dir())
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            "the Mandible runtime controller has no existing managed working directory".to_string()
        })
}

fn isolated_home_selected() -> bool {
    std::env::var("MANDIBLE_HOME")
        .is_ok_and(|value| !value.trim().is_empty() && mandible_home() != default_mandible_home())
}

fn validate_launch_mode(launch_mode: &str) -> Result<(), String> {
    if matches!(launch_mode, "on_demand" | "manual") {
        Ok(())
    } else {
        Err(format!("unsupported launch mode: {launch_mode}"))
    }
}

fn native_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

pub fn run() {
    let preview = native_preview::configuration()
        .expect("invalid native preview configuration; production bootstrap refused");
    let launch_context = NativeLaunchContext(preview.clone());
    let mut context = native_context();
    if let Some(config) = &preview {
        for window in &mut context.config_mut().app.windows {
            window.url =
                tauri::WebviewUrl::External(config.initial_url().expect("invalid preview route"));
            window.title = config.window_title.clone();
            window.visible = true;
            window.focus = true;
        }
    }
    let acceptance =
        acceptance::configuration().expect("invalid candidate acceptance configuration");
    if let Some(config) = &acceptance {
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
            window.url = tauri::WebviewUrl::External(tauri::Url::parse(&config.origin).unwrap());
            // Issue 7d83fe5 — the daemon runs acceptance unattended; its window
            // is never shown and never takes focus on the operator's desktop.
            window.visible = false;
            window.focus = false;
        }
    }
    #[cfg(target_os = "macos")]
    let isolated_store_identifier = (acceptance.is_none() && isolated_home_selected()).then(|| {
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
    let unattended = acceptance.is_some();
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    if preview.is_none() {
        builder = builder.plugin(tauri_plugin_deep_link::init());
    }
    let mut app = builder
        .manage(launch_context)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("native-host")
                .js_init_script(native_frame::host_initialization_script())
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("native-preview-navigation")
                .on_navigation(|webview, url| {
                    let context = webview.state::<NativeLaunchContext>();
                    context
                        .0
                        .as_ref()
                        .map_or(true, |preview| preview.permits(url))
                })
                .build(),
        )
        .manage(NativeWindowCapabilityState::default())
        .on_page_load(|webview, payload| {
            note_dashboard_page_load(webview.label(), payload.url(), payload.event());
            acceptance::page_loaded(webview, payload.url(), payload.event());
            native_preview::page_loaded(webview, payload.url(), payload.event());
        })
        .setup(move |app| {
            if let Some(config) = &acceptance {
                acceptance::install(app, config)?;
            }
            if let Some(config) = &preview {
                native_preview::install(app, config)?;
            }
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
            // titleBarStyle: "Overlay" — the native window chrome would otherwise
            // default to the system light color before the webview paints.
            // Bug: d41755b — white title bar in Tauri app on macOS
            if let Some(window) = app.get_webview_window("main") {
                let dark = tauri::window::Color(11, 15, 20, 255);
                let _ = window.set_background_color(Some(dark));
                #[cfg(target_os = "macos")]
                {
                    configure_regular_liquid_glass(
                        window.clone(),
                        app.state::<NativeWindowCapabilityState>()
                            .liquid_glass_regular
                            .clone(),
                    );
                    native_frame::install(
                        &window,
                        app.state::<NativeWindowCapabilityState>().frame.clone(),
                    )?;
                }
            }
            if preview.is_some() {
                return Ok(());
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
            navigate_to_desktop_bootstrap,
            navigate_to_desktop_dashboard,
            secure_local_connections_status,
            secure_local_connections_setup,
            native_window_capabilities,
            acceptance::candidate_acceptance_report
        ])
        .build(context)
        .expect("error while building Mandible app");
    // Issue 7d83fe5 — an acceptance app may not activate: no Dock icon, no menu
    // bar, and no focus taken at launch. The policy must be set before the
    // event loop launches, because launch activates the app.
    #[cfg(target_os = "macos")]
    if unattended {
        app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    }
    app.run(|_, _| {});
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
        admits_native_command_origin, is_dashboard_origin, is_secure_connections_setup_link,
        resolve_user_path_from, PRODUCTION_ORIGIN,
    };

    #[test]
    fn dashboard_load_completion_accepts_only_the_canonical_origin() {
        assert!(is_dashboard_origin(
            &tauri::Url::parse("https://app.mandible.localhost:19420/inbox").unwrap()
        ));
        assert!(!is_dashboard_origin(
            &tauri::Url::parse("https://app.mandible.localhost:19421/inbox").unwrap()
        ));
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
