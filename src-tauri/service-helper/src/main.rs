use block2::RcBlock;
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_service_management::{SMAppService, SMAppServiceStatus};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let operation = args.first().map(String::as_str).unwrap_or("status");
    let requested: Vec<&str> = if args.len() > 1 {
        args[1..].iter().map(String::as_str).collect()
    } else {
        vec!["backend"]
    };
    let role = requested[0];
    let roles: serde_json::Value =
        serde_json::from_str(include_str!("../../../scripts/bundle-services.json")).unwrap();
    if roles.get(role).and_then(|v| v.as_str()).is_none() {
        return Err("Unknown service role".into());
    }
    let bundle = NSBundle::mainBundle();
    let identifier = bundle
        .bundleIdentifier()
        .ok_or("Service helper must run inside its app bundle")?
        .to_string();
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
    if operation == "foreground"
        || requested.len() > 2
        || requested
            .iter()
            .enumerate()
            .any(|(i, role)| requested[..i].contains(role))
    {
        return Err("Service operations require distinct backend/gateway roles".into());
    }
    let services = requested
        .iter()
        .map(|role| {
            let suffix = roles
                .get(*role)
                .and_then(|v| v.as_str())
                .ok_or("Unknown service role")?;
            let label = format!("{identifier}.{suffix}");
            let service = unsafe {
                SMAppService::agentServiceWithPlistName(&NSString::from_str(&format!(
                    "{label}.plist"
                )))
            };
            Ok((*role, label, service))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut completions = Vec::new();
    let mut pending = 0;
    let mut changed = Vec::new();
    unsafe {
        let permission_required = operation == "register"
            && services
                .iter()
                .any(|(_, _, service)| service.status() == SMAppServiceStatus::RequiresApproval);
        for (role, _, service) in &services {
            let enabled = service.status() == SMAppServiceStatus::Enabled
                || service.status() == SMAppServiceStatus::RequiresApproval;
            let mut registration_changed = false;
            match operation {
                "status" => {},
                "register" => {
                    if !enabled && !permission_required {
                        service.registerAndReturnError().map_err(|e| format!("{role}: {e:?}"))?;
                        registration_changed = true;
                    }
                },
                "unregister" => {
                    if enabled {
                        let sender = sender.clone();
                        let role = role.to_string();
                        let handler = RcBlock::new(move |error: *mut NSError| {
                            let result = if error.is_null() { Ok(()) } else { Err(format!("{role}: {:?}", &*error)) };
                            let _ = sender.send(result);
                        });
                        service.unregisterWithCompletionHandler(&handler);
                        completions.push(handler);
                        pending += 1;
                    }
                },
                "settings" => SMAppService::openSystemSettingsLoginItems(),
                _ => return Err("Usage: mandible-service status|register|unregister|settings|foreground backend [gateway]".into()),
            }
            changed.push(registration_changed);
        }
        // All roles begin unregistering before waiting; completion admits re-registration.
        let mut failure = None;
        for _ in 0..pending {
            if let Err(error) = receiver.recv().map_err(|e| e.to_string())? {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        let statuses: Vec<_> = services.iter().zip(changed).map(|((role, label, service), registration_changed)| {
            let status = match service.status() {
                SMAppServiceStatus::NotRegistered => "not_registered",
                SMAppServiceStatus::Enabled => "enabled",
                SMAppServiceStatus::RequiresApproval => "requires_approval",
                SMAppServiceStatus::NotFound => "not_found",
                _ => "unknown",
            };
            serde_json::json!({ "service": role, "label": label, "status": status,
                "registration_changed": registration_changed, "unregistration_completed": operation == "unregister" })
        }).collect();
        println!(
            "{}",
            if statuses.len() == 1 {
                statuses[0].clone()
            } else {
                serde_json::json!({ "services": statuses })
            }
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
