use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
pub struct CandidateAcceptance {
    pub origin: String,
    pub nonce: String,
    pub home: PathBuf,
}

pub fn configuration() -> Result<Option<CandidateAcceptance>, String> {
    let Some(file) = std::env::var_os("MANDIBLE_CANDIDATE_ACCEPTANCE") else {
        return Ok(None);
    };
    let config: CandidateAcceptance =
        serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let url = tauri::Url::parse(&config.origin).map_err(|e| e.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.origin().ascii_serialization() != config.origin
        || config.nonce.len() != 64
        || !config.home.is_absolute()
        || config.home != crate::mandible_home()
        || !crate::isolated_home_selected()
        || PathBuf::from(std::env::var_os("MANDIBLE_CANDIDATE_ACCEPTANCE").unwrap())
            != config.home.join("acceptance.json")
    {
        return Err(
            "Candidate acceptance requires an exact loopback origin and owned isolated home".into(),
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
