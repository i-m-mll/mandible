use objc2_foundation::{NSBundle, NSString};
use objc2_service_management::{SMAppService, SMAppServiceStatus};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let operation = args.first().map(String::as_str).unwrap_or("status");
    let role = args.get(1).map(String::as_str).unwrap_or("backend");
    let roles: serde_json::Value =
        serde_json::from_str(include_str!("../../../scripts/bundle-services.json")).unwrap();
    let suffix = roles
        .get(role)
        .and_then(|v| v.as_str())
        .ok_or("Unknown service role")?;
    let bundle = NSBundle::mainBundle();
    let identifier = bundle
        .bundleIdentifier()
        .ok_or("Service helper must run inside its app bundle")?
        .to_string();
    let label = format!("{identifier}.{suffix}");
    let root = PathBuf::from(bundle.bundlePath().to_string());
    if !root.extension().is_some_and(|ext| ext == "app") {
        return Err("Service helper must run inside its app bundle".into());
    }
    if operation == "foreground" {
        let account = unsafe { libc::getpwuid(libc::getuid()) };
        if account.is_null() {
            return Err("Cannot resolve service account".into());
        }
        let mut home = unsafe { std::ffi::CStr::from_ptr((*account).pw_dir) }
            .to_string_lossy()
            .into_owned();
        let resources = root.join("Contents/Resources");
        let release: serde_json::Value = serde_json::from_slice(
            &std::fs::read(resources.join("release.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if release["schema"] != "mandible-installed-release@1" {
            return Err("Unsupported installed release".into());
        }
        let resource = |section: &str, key: &str| -> Result<PathBuf, String> {
            let relative = release[section][key]
                .as_str()
                .ok_or("Installed service resource is not declared")?;
            if std::path::Path::new(relative).is_absolute() {
                return Err("Installed resource must be bundle relative".into());
            }
            let file = resources
                .join(relative)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !file.starts_with(root.join("Contents")) || !file.is_file() {
                return Err("Installed resource leaves the app bundle".into());
            }
            Ok(file)
        };
        if identifier.starts_with("bio.mll.mandible.fixture.") {
            let fixture: serde_json::Value = serde_json::from_slice(
                &std::fs::read(resources.join("service-fixture.json"))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            home = fixture["accountHome"]
                .as_str()
                .filter(|value| value.starts_with('/'))
                .ok_or("Fixture account home must be absolute")?
                .to_string();
        }
        let logs = PathBuf::from(&home).join(".cache/mandible");
        std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
        let prefix = if role == "backend" {
            "production"
        } else {
            "local-front-door"
        };
        for (fd, suffix) in [
            (libc::STDOUT_FILENO, "stdout"),
            (libc::STDERR_FILENO, "stderr"),
        ] {
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(logs.join(format!("{prefix}-{suffix}.log")))
                .map_err(|e| e.to_string())?;
            if unsafe { libc::dup2(log.as_raw_fd(), fd) } < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let error = Command::new(resource("native", "bun")?)
            .arg(resource("entrypoints", "service")?)
            .arg(role)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("MANDIBLE_RELEASE_ROOT", &resources)
            .current_dir(&resources)
            .exec();
        return Err(format!("Cannot execute bundled service runtime: {error}"));
    }
    let service = unsafe {
        SMAppService::agentServiceWithPlistName(&NSString::from_str(&format!("{label}.plist")))
    };
    unsafe {
        match operation {
            "status" => {},
            "register" => {
                if service.status() != SMAppServiceStatus::Enabled && service.status() != SMAppServiceStatus::RequiresApproval {
                    service.registerAndReturnError().map_err(|e| format!("{e:?}"))?;
                }
            },
            "unregister" => {
                if service.status() == SMAppServiceStatus::Enabled || service.status() == SMAppServiceStatus::RequiresApproval {
                    service.unregisterAndReturnError().map_err(|e| format!("{e:?}"))?;
                }
            },
            "settings" => SMAppService::openSystemSettingsLoginItems(),
            _ => return Err("Usage: mandible-service status|register|unregister|settings|foreground backend|gateway".into()),
        }
        let status = match service.status() {
            SMAppServiceStatus::NotRegistered => "not_registered",
            SMAppServiceStatus::Enabled => "enabled",
            SMAppServiceStatus::RequiresApproval => "requires_approval",
            SMAppServiceStatus::NotFound => "not_found",
            _ => "unknown",
        };
        println!(
            "{}",
            serde_json::json!({ "service": role, "label": label, "status": status })
        );
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
