use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
pub struct CandidateAcceptance {
    pub origin: String,
    pub nonce: String,
    pub home: PathBuf,
}

fn accepts_origin(url: &tauri::Url, origin: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("app.mandible.localhost")
        && url.port().is_some()
        && url.origin().ascii_serialization() == origin
}

pub fn configuration() -> Result<Option<CandidateAcceptance>, String> {
    let Some(file) = std::env::var_os("MANDIBLE_CANDIDATE_ACCEPTANCE") else {
        return Ok(None);
    };
    let config: CandidateAcceptance =
        serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let url = tauri::Url::parse(&config.origin).map_err(|e| e.to_string())?;
    if !accepts_origin(&url, &config.origin)
        || config.nonce.len() != 64
        || !config.home.is_absolute()
        || config.home != crate::mandible_home()
        || !crate::isolated_home_selected()
        || PathBuf::from(std::env::var_os("MANDIBLE_CANDIDATE_ACCEPTANCE").unwrap())
            != config.home.join("acceptance.json")
    {
        return Err(
            "Candidate acceptance requires an exact Mandible HTTPS origin and owned isolated home"
                .into(),
        );
    }
    Ok(Some(config))
}

#[tauri::command]
pub fn candidate_acceptance_report(
    window: WebviewWindow,
    nonce: String,
    evidence: serde_json::Value,
) -> Result<(), String> {
    let config = configuration()?.ok_or("Candidate acceptance is inactive")?;
    if nonce != config.nonce
        || window.label() != "main"
        || window
            .url()
            .map_err(|e| e.to_string())?
            .origin()
            .ascii_serialization()
            != config.origin
    {
        return Err("Candidate acceptance report does not match its owned window".into());
    }
    fs::write(
        config.home.join("desktop-evidence.json"),
        serde_json::to_vec(&evidence).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn install(
    app: &tauri::App,
    config: &CandidateAcceptance,
) -> Result<(), Box<dyn std::error::Error>> {
    app.add_capability(
        serde_json::json!({
            "identifier": "candidate-acceptance", "windows": ["main"],
            "remote": { "urls": [config.origin] },
            "permissions": ["allow-candidate-acceptance"]
        })
        .to_string(),
    )?;
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
    let Ok(Some(config)) = configuration() else {
        return;
    };
    if webview.label() != "main" || url.origin().ascii_serialization() != config.origin {
        return;
    }
    let nonce = serde_json::to_string(&config.nonce).unwrap();
    let script = format!(
        r#"(async () => {{
      const report = evidence => window.__TAURI__.core.invoke('candidate_acceptance_report', {{nonce:{nonce}, evidence}});
      try {{
        const until = async predicate => {{ const end = Date.now()+15000; while(Date.now()<end) {{ if(predicate()) return; await new Promise(r=>setTimeout(r,50)); }} throw new Error('dashboard interaction timed out'); }};
        await until(() => document.querySelector('a[aria-label="Settings"]'));
        document.querySelector('a[aria-label="Settings"]').click();
        await until(() => location.hash.startsWith('#/settings') && document.querySelector('input,select'));
        await until(() => {{ const field = document.getElementById('settings-app-theme'); return field && !field.disabled; }});
        const theme = document.getElementById('settings-app-theme');
        const before = await (await fetch('/api/host-preferences/app-theme')).json();
        const next = before.value === 'dark' ? 'light' : 'dark';
        theme.value = next;
        theme.dispatchEvent(new Event('change', {{bubbles:true}}));
        let persisted;
        const end = Date.now()+15000;
        while (Date.now()<end) {{
          const response = await fetch('/api/host-preferences/app-theme');
          if (!response.ok) throw new Error('theme request: '+response.status);
          persisted = await response.json();
          if (persisted.value === next && persisted.revision > before.revision) break;
          await new Promise(r=>setTimeout(r,100));
        }}
        if (persisted?.value !== next || persisted.revision <= before.revision) throw new Error('Settings edit was not persisted');
        await report({{passed:true, url:location.href, rendered:document.body.innerText.includes('App theme'), edit:{{key:'app_theme',before:before.value,after:persisted.value,revision:persisted.revision}}}});
      }} catch(error) {{ await report({{passed:false,error:String(error)}}); }}
    }})()"#
    );
    if let Err(error) = webview.eval(&script) {
        eprintln!("candidate_acceptance_eval_failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::accepts_origin;

    #[test]
    fn acceptance_requires_the_exact_https_local_dashboard_origin() {
        for origin in [
            "https://app.mandible.localhost:19420",
            "https://app.mandible.localhost:60408",
        ] {
            assert!(accepts_origin(&tauri::Url::parse(origin).unwrap(), origin));
        }
        for origin in [
            "http://127.0.0.1:60408",
            "http://app.mandible.localhost:60408",
            "https://other.mandible.localhost:60408",
            "https://app.mandible.localhost",
            "https://app.mandible.localhost:60408/path",
            "https://app.mandible.localhost:60408?query=1",
            "https://user@app.mandible.localhost:60408",
            "https://app.mandible.localhost.example:60408",
        ] {
            assert!(
                !accepts_origin(&tauri::Url::parse(origin).unwrap(), origin),
                "{origin}"
            );
        }
    }
}
