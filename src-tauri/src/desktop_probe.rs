use std::path::Path;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use reqwest::blocking::Client;
    use rustls_pki_types::{pem::PemObject, CertificateDer};
    use security_framework::{
        certificate::SecCertificate, policy::SecPolicy, secure_transport::SslProtocolSide,
        trust::SecTrust,
    };
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::Read;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::path::PathBuf;
    use std::time::Duration;

    const HEALTH_TIMEOUT: Duration = Duration::from_millis(650);
    const HEALTH_LIMIT: u64 = 256 * 1024;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BundleOwner {
        schema: String,
        generation: String,
        installation_id: String,
    }

    #[derive(Deserialize)]
    struct CaReceipt {
        schema: String,
        state: String,
        storage_root: PathBuf,
        root_digest: String,
        installation_digest: String,
    }

    #[derive(Deserialize)]
    struct Health {
        status: String,
        ready: bool,
        startup_epoch: String,
        instance: Instance,
    }

    #[derive(Deserialize)]
    struct Instance {
        role: String,
        instance_id: String,
        installation_id: String,
        public_origin: String,
        backend_generation: String,
    }

    fn ordinary_file(path: &Path) -> Result<Vec<u8>, String> {
        if !fs::symlink_metadata(path)
            .map_err(|error| format!("{}: {error}", path.display()))?
            .is_file()
        {
            return Err(format!("{} is not a regular file", path.display()));
        }
        fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    pub(super) fn probe(home: &Path) -> Result<String, String> {
        let config = home.join("config");
        let runtime = config.join("local-sessions");
        let authority = ordinary_file(&config.join("client-auth/authority-id"))?;
        let installation = std::str::from_utf8(&authority)
            .map_err(|error| error.to_string())?
            .trim();
        let owner: BundleOwner =
            serde_json::from_slice(&ordinary_file(&runtime.join("bundle-owner.json"))?)
                .map_err(|error| error.to_string())?;
        if installation.is_empty()
            || owner.schema != "mandible-bundle-owner@1"
            || owner.installation_id != installation
            || owner.generation.len() != 40
            || !owner
                .generation
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(
                "The production bundle owner does not match its installation authority".into(),
            );
        }

        let trust: CaReceipt =
            serde_json::from_slice(&ordinary_file(&runtime.join("ca-trust.json"))?)
                .map_err(|error| error.to_string())?;
        let storage = runtime.join("caddy-storage");
        let pem = ordinary_file(&storage.join("pki/authorities/local/root.crt"))?;
        if trust.schema != "mandible-local-ca-trust@1"
            || trust.state != "trusted"
            || trust.storage_root != storage
            || trust.root_digest != digest(&pem)
            || trust.installation_digest != digest(&authority)
        {
            return Err("The local CA does not match its installation trust receipt".into());
        }

        let der = CertificateDer::from_pem_slice(&pem).map_err(|error| error.to_string())?;
        let system_cert =
            SecCertificate::from_der(der.as_ref()).map_err(|error| error.to_string())?;
        let mut system_trust = SecTrust::create_with_certificates(
            &[system_cert],
            &[SecPolicy::create_ssl(SslProtocolSide::SERVER, None)],
        )
        .map_err(|error| error.to_string())?;
        system_trust
            .set_network_fetch_allowed(false)
            .map_err(|error| error.to_string())?;
        system_trust
            .evaluate_with_error()
            .map_err(|error| error.to_string())?;

        let origin = reqwest::Url::parse(super::super::PRODUCTION_ORIGIN)
            .map_err(|error| error.to_string())?;
        let host = origin
            .host_str()
            .ok_or("The canonical dashboard origin has no host")?;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(host, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .timeout(HEALTH_TIMEOUT)
            .tls_certs_only([
                reqwest::Certificate::from_der(der.as_ref()).map_err(|error| error.to_string())?
            ])
            .build()
            .map_err(|error| error.to_string())?;
        let response = client
            .get(
                origin
                    .join("/api/health")
                    .map_err(|error| error.to_string())?,
            )
            .header("Accept", "application/json")
            .send()
            .map_err(|error| error.to_string())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "The local dashboard returned HTTP {}",
                response.status()
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(HEALTH_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 > HEALTH_LIMIT {
            return Err("The local dashboard returned an oversized health response".into());
        }
        let health: Health = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if health.status != "ok"
            || !health.ready
            || health.startup_epoch.is_empty()
            || health.instance.role != "main"
            || health.instance.instance_id != "production"
            || health.instance.installation_id != installation
            || health.instance.public_origin != super::super::PRODUCTION_ORIGIN
            || health.instance.backend_generation != owner.generation
        {
            return Err(
                "The canonical local dashboard is not serving the ready production bundle".into(),
            );
        }
        Ok(health.startup_epoch)
    }
}

pub fn probe(home: &Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return macos::probe(home);

    #[cfg(not(target_os = "macos"))]
    Err(format!(
        "Native daemon probing is unavailable for {}",
        home.display()
    ))
}
