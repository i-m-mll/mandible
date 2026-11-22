use serde::Deserialize;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};

static STARTED: OnceLock<Instant> = OnceLock::new();
static LAUNCH_IMAGE: OnceLock<LaunchImage> = OnceLock::new();
static REPLACEMENT: OnceLock<Option<Replacement>> = OnceLock::new();
const TRACE_LIMIT_BYTES: u64 = 1_048_576;

#[derive(Default)]
pub struct FrameState {
    frames: Mutex<Frames>,
}

#[derive(Default)]
struct Frames {
    bootstrap: bool,
    dashboard: bool,
    bootstrap_painted: bool,
    dashboard_painted: bool,
    shown: bool,
    startup_epoch: Option<String>,
}

struct Replacement {
    scope: String,
    token: String,
}

struct LaunchImage {
    at_ms: u128,
    inode: u64,
}

#[derive(Deserialize)]
struct ReplacementRoute {
    schema: String,
    token: String,
    href: String,
}

fn runtime_dir() -> PathBuf {
    super::mandible_home().join("config/local-sessions")
}

fn replacement() -> Option<&'static Replacement> {
    REPLACEMENT
        .get_or_init(|| {
            let argument = std::env::args()
                .skip_while(|argument| argument != "--mandible-update-paint")
                .nth(1)?;
            let (scope, token) = argument.split_once(':')?;
            let valid_scope = (17..=257).contains(&scope.len())
                && scope
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
            let valid_token = token.len() == 32
                && token
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
            (valid_scope && valid_token).then(|| Replacement {
                scope: scope.into(),
                token: token.into(),
            })
        })
        .as_ref()
}

fn trace_path() -> PathBuf {
    runtime_dir().join("desktop-startup.jsonl")
}

pub fn start() {
    STARTED
        .set(Instant::now())
        .expect("desktop startup starts once");
    #[cfg(unix)]
    if let Ok(image) = std::env::current_exe().and_then(fs::metadata) {
        LAUNCH_IMAGE
            .set(LaunchImage {
                at_ms: wall_time_ms(),
                inode: image.ino(),
            })
            .ok();
    }
    let path = trace_path();
    if fs::metadata(&path).is_ok_and(|file| file.len() >= TRACE_LIMIT_BYTES) {
        if let Err(error) = fs::rename(&path, path.with_extension("jsonl.1")) {
            eprintln!("Could not rotate desktop startup trace: {error}");
        }
    }
    trace("launch", None, None, None, None);
}

fn wall_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis()
}

fn dashboard_route(href: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(href).map_err(|error| error.to_string())?;
    if href.len() > 4_096
        || !super::is_dashboard_origin(&url)
        || !url.username().is_empty()
        || url.password().is_some()
        || matches!(
            url.path_segments().and_then(|mut segments| segments.next()),
            Some("api" | "dist" | "r")
        )
    {
        return Err("The desktop handover route is outside the canonical dashboard".into());
    }
    Ok(url)
}

pub fn replacement_route(app: &AppHandle) -> Result<Option<tauri::Url>, String> {
    let Some(update) = replacement() else {
        return Ok(None);
    };
    if app.state::<FrameState>().frames.lock().unwrap().dashboard {
        return Ok(None);
    }
    let file = replacement_directory(&runtime_dir(), update)?
        .join(format!("desktop-route-{}.json", update.token));
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || metadata.len() > 8_192 {
        return Err("The desktop handover route must be an owned regular file".into());
    }
    let record: ReplacementRoute =
        serde_json::from_slice(&fs::read(file).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    if record.schema != "mandible-desktop-handover-route@1" || record.token != update.token {
        return Err("The desktop handover route belongs to another launch".into());
    }
    dashboard_route(&record.href).map(Some)
}

pub fn trace(
    phase: &str,
    frame: Option<&str>,
    startup_epoch: Option<&str>,
    request_id: Option<&str>,
    web_at_ms: Option<u64>,
) {
    let record = json!({
        "event": "desktop_startup", "phase": phase, "pid": std::process::id(),
        "at_ms": wall_time_ms(), "elapsed_ms": STARTED.get().map(|start| start.elapsed().as_millis()),
        "frame": frame, "startup_epoch": startup_epoch, "request_id": request_id, "web_at_ms": web_at_ms,
    });
    let line = format!("{record}\n");
    eprint!("{line}");
    let path = trace_path();
    if let Err(error) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(line.as_bytes()))
    {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Could not persist desktop startup trace: {error}");
        }
    }
}

pub fn probe_ready(app: &AppHandle, epoch: String) {
    trace("probe_ready", None, Some(&epoch), None, None);
    app.state::<FrameState>()
        .frames
        .lock()
        .unwrap()
        .startup_epoch = Some(epoch);
}

fn validate_frame_origin(window: &WebviewWindow, dashboard: bool) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Desktop startup frame must belong to the main window".into());
    }
    let url = window.url().map_err(|error| error.to_string())?;
    if let Some(config) = super::acceptance::configuration()? {
        if dashboard && url.origin().ascii_serialization() == config.origin {
            return Ok(true);
        }
        return Err("Desktop startup frame must belong to the owned acceptance origin".into());
    }
    super::require_production_context(window.app_handle())?;
    if dashboard && super::is_dashboard_origin(&url)
        || !dashboard && url.scheme() == "tauri" && url.host_str() == Some("localhost")
    {
        return Ok(false);
    }
    Err("Desktop startup frame belongs to an untrusted origin".into())
}

fn replacement_directory(directory: &Path, replacement: &Replacement) -> Result<PathBuf, String> {
    let parent = directory.join("handoff").join(&replacement.scope);
    if !fs::symlink_metadata(&parent).is_ok_and(|entry| entry.is_dir()) {
        return Err("Desktop replacement journal is unavailable".into());
    }
    Ok(parent)
}

fn publish_paint(
    directory: &Path,
    replacement: &Replacement,
    epoch: Option<&str>,
) -> Result<(), String> {
    let parent = replacement_directory(directory, replacement)?;
    let file = parent.join(format!("desktop-paint-{}.json", replacement.token));
    let pid = std::process::id();
    let temporary = parent.join(format!(".desktop-paint-{}-{pid}.tmp", replacement.token));
    let evidence = json!({ "schema": "mandible-desktop-paint@1", "token": replacement.token, "pid": pid, "startup_epoch": epoch });
    let result = (|| -> std::io::Result<()> {
        let mut handle = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        writeln!(handle, "{evidence}")?;
        handle.sync_all()?;
        fs::rename(&temporary, &file)
    })();
    if result.is_err() {
        fs::remove_file(&temporary).ok();
    }
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_route_observed(window: WebviewWindow, href: String) -> Result<(), String> {
    if validate_frame_origin(&window, true)? {
        return Err("Candidate acceptance does not persist desktop routes".into());
    }
    let Some(launch) = LAUNCH_IMAGE.get() else {
        return Ok(());
    };
    let url = dashboard_route(&href)?;
    let runtime = runtime_dir();
    let pid = std::process::id();
    let temporary = runtime.join(format!(".desktop-route-{pid}-{}.tmp", launch.at_ms));
    let evidence = json!({ "schema": "mandible-desktop-route@1", "pid": pid, "desktop_started_at_ms": launch.at_ms,
        "image_inode": launch.inode, "href": url.as_str() });
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary)?;
        let result = writeln!(file, "{evidence}")
            .and_then(|()| fs::rename(&temporary, runtime.join("desktop-route.json")));
        if result.is_err() {
            fs::remove_file(&temporary).ok();
        }
        result
    })();
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_frame_ready(
    window: WebviewWindow,
    state: tauri::State<'_, FrameState>,
    dashboard: bool,
    daemon_startup_epoch: Option<String>,
) -> Result<(), String> {
    let unattended = validate_frame_origin(&window, dashboard)?;
    let mut frame = state.frames.lock().unwrap();
    if let Some(epoch) = daemon_startup_epoch.filter(|epoch| !epoch.is_empty() && epoch.len() <= 64)
    {
        frame.startup_epoch = Some(epoch);
    }
    if if dashboard {
        frame.dashboard
    } else {
        frame.bootstrap
    } {
        return Ok(());
    }

    let kind = if dashboard { "dashboard" } else { "bootstrap" };
    let epoch = frame.startup_epoch.as_deref();
    trace("first_frame_ready", Some(kind), epoch, None, None);
    let update = replacement();
    if !unattended && !frame.shown && (dashboard || update.is_none()) {
        window.show().map_err(|error| error.to_string())?;
        if update.is_none() {
            window.set_focus().map_err(|error| error.to_string())?;
        }
        trace("window_shown", Some(kind), epoch, None, None);
        frame.shown = true;
    }
    if let (true, false, Some(update)) = (dashboard, unattended, update) {
        publish_paint(&runtime_dir(), update, frame.startup_epoch.as_deref())?;
    }
    if dashboard {
        frame.dashboard = true;
    } else {
        frame.bootstrap = true;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_frame_painted(
    window: WebviewWindow,
    state: tauri::State<'_, FrameState>,
    dashboard: bool,
    daemon_startup_epoch: Option<String>,
) -> Result<(), String> {
    validate_frame_origin(&window, dashboard)?;
    let mut frame = state.frames.lock().unwrap();
    let kinds = if dashboard {
        (frame.dashboard, frame.dashboard_painted, "dashboard")
    } else {
        (frame.bootstrap, frame.bootstrap_painted, "bootstrap")
    };
    if kinds.0 && !kinds.1 {
        let epoch = daemon_startup_epoch
            .as_deref()
            .filter(|epoch| epoch.len() <= 64)
            .or(frame.startup_epoch.as_deref());
        trace("first_frame_painted", Some(kinds.2), epoch, None, None);
        if dashboard {
            frame.dashboard_painted = true;
        } else {
            frame.bootstrap_painted = true;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebOutagePhase {
    WebOutageStarted,
    WebOutageReady,
}

#[tauri::command]
pub fn desktop_trace(
    window: WebviewWindow,
    phase: WebOutagePhase,
    at_ms: u64,
    startup_epoch: Option<String>,
    request_id: Option<String>,
) -> Result<(), String> {
    validate_frame_origin(&window, true)?;
    let phase = match phase {
        WebOutagePhase::WebOutageStarted => "web_outage_started",
        WebOutagePhase::WebOutageReady => "web_outage_ready",
    };
    trace(
        phase,
        Some("dashboard"),
        startup_epoch.as_deref().filter(|id| id.len() <= 64),
        request_id.as_deref().filter(|id| id.len() <= 64),
        Some(at_ms),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::dashboard_route;

    #[test]
    fn handover_routes_use_only_the_exact_dashboard_origin() {
        assert!(dashboard_route(
            "https://app.mandible.localhost:19420/issue/abcd?sidebar=hidden#note"
        )
        .is_ok());
        for unsafe_route in [
            "http://app.mandible.localhost:19420/issues",
            "https://app.mandible.localhost:19421/issues",
            "https://app.mandible.localhost.example:19420/issues",
            "https://name:pass@app.mandible.localhost:19420/issues",
            "https://app.mandible.localhost:19420/api/health",
            "https://app.mandible.localhost:19420/r/issue/abcd",
            "/issues",
        ] {
            assert!(dashboard_route(unsafe_route).is_err(), "{unsafe_route}");
        }
    }
}
