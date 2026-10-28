/** HTTP streams can reconnect; durable work drains in the backend. */
export function gatewayGlobalOptions({ adminAddress = null, storageRoot }) {
  return `{\n  admin ${adminAddress === null ? 'off' : JSON.stringify(adminAddress)}\n  storage file_system ${JSON.stringify(storageRoot)}\n  grace_period 1s\n  local_certs\n  skip_install_trust\n  auto_https disable_redirects\n}`;
}

export function gatewayCaddyfile(instances, { adminAddress, storageRoot }) {
  const production = instances.find((entry) => entry.role === "main");
  if (!production) throw new Error("The production instance is not registered.");
  const effectivePort = (url) => url.port || (url.protocol === "https:" ? "443" : "80");
  const publicPorts = new Set(instances.map((entry) => effectivePort(new URL(entry.public_origin))));
  for (const entry of instances) {
    const backendPort = effectivePort(new URL(entry.backend_origin));
    if (publicPorts.has(backendPort)) {
      throw new Error(`Refusing gateway self-route: ${entry.instance_id} backend port ${backendPort} is a public listener port.`);
    }
  }
  const productionBackend = new URL(production.backend_origin);
  const productionPublic = new URL(production.public_origin);
  const globalOptions = gatewayGlobalOptions({ adminAddress, storageRoot });
  const blocks = instances.map((entry) => {
    const publicUrl = new URL(entry.public_origin);
    const backendUrl = new URL(entry.backend_origin);
    const shared = [
      `${publicUrl.origin} {`,
      "  bind 127.0.0.1 ::1",
      "  tls internal",
      "  header -Server",
    ];
    if (entry.role === "preview") {
      shared.push(
        "  handle {",
        `    forward_auth ${productionBackend.origin} {`,
        "      uri /api/client-auth/forward-auth",
        `      header_up Host ${productionPublic.host}`,
        `      header_up Origin ${productionPublic.origin}`,
        `      header_up X-Mandible-Target-Instance ${entry.instance_id}`,
        "      header_up -Authorization",
        "      header_up -Cookie",
        "      copy_headers X-Mandible-Session-Context",
        "    }",
        `    reverse_proxy ${backendUrl.origin} {`,
        "      header_up -Authorization",
        "      header_up -Cookie",
        "      header_up -X-Mandible-Target-Instance",
        "      header_up X-Mandible-Session-Context {http.request.header.X-Mandible-Session-Context}",
        "    }",
        "  }",
      );
    } else {
      shared.push(
        `  reverse_proxy ${backendUrl.origin} {`,
        "    header_up -X-Mandible-Target-Instance",
        "    header_up -X-Mandible-Session-Context",
        "  }",
      );
    }
    shared.push("}");
    return shared.join("\n");
  });
  return `${globalOptions}\n\n${blocks.join("\n\n")}\n`;
}
