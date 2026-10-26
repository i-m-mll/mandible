use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreview {
    pub manifest: PathBuf,
    pub origin: String,
    pub instance_id: String,
    pub run_id: String,
    pub preview_run_id: String,
    pub home: PathBuf,
    pub window_title: String,
    pub agent_session: Option<String>,
}

fn read_json(file: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

impl NativePreview {
    pub fn permits(&self, url: &tauri::Url) -> bool {
        url.origin().ascii_serialization() == self.origin
    }

    pub fn initial_url(&self) -> Result<tauri::Url, String> {
        let mut url = tauri::Url::parse(&self.origin).map_err(|e| e.to_string())?;
        let mut fragment = String::from("/overview");
        if let Some(session) = &self.agent_session {
            url.query_pairs_mut().append_pair("agent_session", session);
            let query = url.query().unwrap().to_string();
            url.set_query(None);
            fragment.push('?');
            fragment.push_str(&query);
        }
        url.set_fragment(Some(&fragment));
        Ok(url)
    }

    fn validate(&self, manifest: &Value, health: &Value) -> Result<(), String> {
        let root = self
            .manifest
            .parent()
            .ok_or("Preview manifest has no root")?;
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let expected_instance = format!(
            "preview-{:x}",
            Sha256::digest(root.as_os_str().as_encoded_bytes())
        );
        let expected_instance = &expected_instance[..24];
        let ownership = &manifest["ownership"];
        let env = &manifest["instanceEnv"];
        let instance = &health["instance"];
        let url = tauri::Url::parse(&self.origin).map_err(|e| e.to_string())?;
        let expected_host = format!("{}.mandible.localhost", self.instance_id);
        let home = fs::canonicalize(&self.home).map_err(|e| e.to_string())?;
        let native_owner = read_json(
            &home
                .parent()
                .ok_or("Missing native run root")?
                .join("metadata.json"),
        )?;
        if self.instance_id != expected_instance
            || !self.instance_id.starts_with("preview-")
            || self.instance_id.len() != 24
            || !self.instance_id[8..].bytes().all(|c| c.is_ascii_hexdigit())
            || url.scheme() != "https"
            || url.host_str() != Some(expected_host.as_str())
            || url.port() != Some(19421)
            || url.as_str() != format!("{}/", self.origin)
            || self.manifest.file_name().and_then(|n| n.to_str()) != Some("metadata.json")
            || manifest["previewRoot"].as_str() != root.to_str()
            || ownership["root"].as_str() != root.to_str()
            || ownership["schema"] != "mandible-owned-run@1"
            || ownership["state"] != "active"
            || ownership["instanceId"] != self.instance_id
            || ownership["runId"] != self.preview_run_id
            || env["MANDIBLE_INSTANCE_ID"] != self.instance_id
            || env["MANDIBLE_PUBLIC_ORIGIN"] != self.origin
            || health["ready"] != true
            || health["warm"] != true
            || instance["role"] != "preview"
            || instance["instance_id"] != self.instance_id
            || instance["public_origin"] != self.origin
            || instance["installation_id"] != env["MANDIBLE_INSTALLATION_ID"]
            || instance["db_path"] != manifest["db"]
            || instance["db_path_source"] != "iab-preview-copy"
            || instance["source_db_path"] != manifest["sourceDb"]
            || instance["allowed_effects"]
                != serde_json::json!([
                    "ledger:read",
                    "ledger:write",
                    "files:preview",
                    "preferences:instance"
                ])
            || health["startup_commit"]["hash"] != env["MANDIBLE_BACKEND_GENERATION"]
            || home != self.home
            || home.starts_with(&root)
            || home.starts_with(crate::default_mandible_home())
            || native_owner["ownership"]["runId"] != self.run_id
            || native_owner["ownership"]["root"].as_str() != home.parent().and_then(|p| p.to_str())
            || native_owner["ownership"]["instanceId"] != self.instance_id
        {
            return Err("Native preview requires a healthy launcher-owned preview and a separate owned native profile".into());
        }
        Ok(())
    }
}

pub fn configuration() -> Result<Option<NativePreview>, String> {
    let Some(file) = std::env::var_os("MANDIBLE_NATIVE_PREVIEW") else {
        return Ok(None);
    };
    if std::env::var_os("MANDIBLE_CANDIDATE_ACCEPTANCE").is_some() {
        return Err("Native preview and hidden acceptance are mutually exclusive".into());
    }
    let config: NativePreview =
        serde_json::from_value(read_json(Path::new(&file))?).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    return Err("Native preview requires macOS 14+ isolated WebKit storage".into());
    if !crate::isolated_home_selected()
        || config.home != crate::mandible_home()
        || crate::mandible_config_dir() != config.home.join("config")
        || PathBuf::from(file) != config.home.join("native-preview.json")
    {
        return Err("Native preview context must live in its owned profile".into());
    }
    let manifest = read_json(&config.manifest)?;
    let port = manifest["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("Invalid preview port")?;
    let response = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("http://127.0.0.1:{port}/api/health"))
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;
    let health = serde_json::from_str(&response).map_err(|e| e.to_string())?;
    config.validate(&manifest, &health)?;
    Ok(Some(config))
}

fn capability(config: &NativePreview) -> String {
    serde_json::json!({
        "identifier": "native-preview", "windows": ["main"], "local": false,
        "remote": { "urls": [config.origin] },
        "permissions": ["allow-native-presentation", "core:window:allow-set-theme", "core:window:allow-start-dragging"]
    }).to_string()
}

pub fn install(app: &tauri::App, config: &NativePreview) -> Result<(), Box<dyn std::error::Error>> {
    app.add_capability(capability(config))?;
    Ok(())
}

pub fn page_loaded(
    webview: &tauri::Webview,
    url: &tauri::Url,
    event: tauri::webview::PageLoadEvent,
) {
    if !matches!(event, tauri::webview::PageLoadEvent::Finished) {
        return;
    }
    let context = webview.state::<crate::NativeLaunchContext>();
    let Some(config) = &context.0 else { return };
    if webview.label() == "main" && config.permits(url) {
        let evidence = serde_json::json!({"pid": std::process::id(), "origin": config.origin,
            "instanceId": config.instance_id, "runId": config.run_id, "windowLabel": "main",
            "windowTitle": config.window_title, "url": url.as_str(), "profile": config.home});
        let pending = config.home.join("native-ready.json.partial");
        if let Err(error) = fs::write(&pending, evidence.to_string())
            .and_then(|_| fs::rename(pending, config.home.join("native-ready.json")))
        {
            eprintln!("Cannot record native preview window identity: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_identity_and_profile_validation_refuse_foreign_targets_before_bootstrap() {
        let base = std::env::temp_dir().join(format!(
            "mandible-native-preview-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let preview = base.join("daemon");
        let native = base.join("native");
        let home = native.join("profile");
        fs::create_dir_all(&preview).unwrap();
        fs::create_dir_all(&home).unwrap();
        let preview = fs::canonicalize(preview).unwrap();
        let native = fs::canonicalize(native).unwrap();
        let home = fs::canonicalize(home).unwrap();
        let instance = format!(
            "preview-{:x}",
            Sha256::digest(preview.as_os_str().as_encoded_bytes())
        )[..24]
            .to_string();
        let origin = format!("https://{instance}.mandible.localhost:19421");
        let config = NativePreview {
            manifest: preview.join("metadata.json"),
            origin: origin.clone(),
            instance_id: instance.clone(),
            run_id: "native-run".into(),
            preview_run_id: "daemon-run".into(),
            home: home.clone(),
            window_title: "Preview".into(),
            agent_session: Some("session & other".into()),
        };
        fs::write(
            native.join("metadata.json"),
            serde_json::json!({"ownership": {
                "runId": "native-run", "root": native, "instanceId": instance
            }})
            .to_string(),
        )
        .unwrap();
        let manifest = serde_json::json!({ "previewRoot": preview,
            "db": preview.join("ledger.db"), "sourceDb": base.join("source.db"),
            "ownership": { "root": preview, "schema": "mandible-owned-run@1", "state": "active", "instanceId": instance, "runId": "daemon-run" },
            "instanceEnv": { "MANDIBLE_INSTANCE_ID": instance, "MANDIBLE_PUBLIC_ORIGIN": origin,
                "MANDIBLE_INSTALLATION_ID": "installation", "MANDIBLE_BACKEND_GENERATION": "generation" } });
        let health = serde_json::json!({ "ready": true, "warm": true, "startup_commit": { "hash": "generation" },
            "instance": { "role": "preview", "instance_id": instance, "public_origin": origin, "installation_id": "installation",
                "db_path": preview.join("ledger.db"), "source_db_path": base.join("source.db"), "db_path_source": "iab-preview-copy",
                "allowed_effects": ["ledger:read", "ledger:write", "files:preview", "preferences:instance"] } });
        assert!(config.validate(&manifest, &health).is_ok());
        let mut context = crate::native_context();
        let authority = context.runtime_authority_mut();
        authority.add_capability(capability(&config)).unwrap();
        let selected = tauri::ipc::Origin::Remote {
            url: config.initial_url().unwrap(),
        };
        for command in [
            "native_window_capabilities",
            "plugin:window|start_dragging",
            "plugin:window|set_theme",
        ] {
            assert!(
                authority
                    .resolve_access(command, "main", "main", &selected)
                    .is_some(),
                "{command}"
            );
        }
        for command in [
            "daemon_status",
            "daemon_start",
            "daemon_restart",
            "daemon_set_launch_mode",
            "navigate_to_desktop_dashboard",
            "navigate_to_desktop_bootstrap",
            "secure_local_connections_setup",
        ] {
            assert!(
                authority
                    .resolve_access(command, "main", "main", &selected)
                    .is_none(),
                "{command}"
            );
        }
        let foreign = tauri::ipc::Origin::Remote {
            url: tauri::Url::parse("https://example.com").unwrap(),
        };
        assert!(authority
            .resolve_access("native_window_capabilities", "main", "main", &foreign)
            .is_none());
        let production = tauri::ipc::Origin::Remote {
            url: tauri::Url::parse(crate::PRODUCTION_ORIGIN).unwrap(),
        };
        assert!(authority
            .resolve_access("daemon_start", "main", "main", &production)
            .is_some());
        assert!(config.permits(&config.initial_url().unwrap()));
        assert!(!config.permits(&tauri::Url::parse(crate::PRODUCTION_ORIGIN).unwrap()));
        assert!(!config.permits(&tauri::Url::parse("https://example.com").unwrap()));
        assert!(config
            .initial_url()
            .unwrap()
            .fragment()
            .unwrap()
            .contains("agent_session=session+%26+other"));
        for (pointer, value) in [
            ("/instance/role", "production"),
            ("/instance/installation_id", "foreign"),
            ("/instance/public_origin", crate::PRODUCTION_ORIGIN),
            ("/instance/instance_id", "preview-foreign"),
        ] {
            let mut mismatched = health.clone();
            *mismatched.pointer_mut(pointer).unwrap() = value.into();
            assert!(
                config.validate(&manifest, &mismatched).is_err(),
                "{pointer}"
            );
        }
        let mut foreign = config.clone();
        foreign.origin = crate::PRODUCTION_ORIGIN.into();
        assert!(foreign.validate(&manifest, &health).is_err());
        foreign = config.clone();
        foreign.home = preview.clone();
        assert!(foreign.validate(&manifest, &health).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
