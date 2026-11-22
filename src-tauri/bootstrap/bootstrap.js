(function () {
  const POLL_MS = 1200;
  const controls = document.getElementById("bootstrap-controls");
  const errorMessage = document.getElementById("bootstrap-error");
  const startButton = document.getElementById("start-btn");
  const retryButton = document.getElementById("retry-btn");
  const query = new URLSearchParams(window.location.search);
  let autoStartAttempted = query.get("skip_autostart") === "1";
  let navigationFailed = query.get("dashboard_navigation_failed") === "1";
  let status;
  let pollTimer;

  function invoke(command, args) {
    return window.__TAURI__.core.invoke(command, args);
  }

  function setBusy(busy) {
    startButton.disabled = busy;
    retryButton.disabled = busy;
  }

  function showControls(message, startAction) {
    errorMessage.textContent = message ?? "";
    errorMessage.hidden = !message;
    startButton.textContent = startAction ?? "";
    startButton.hidden = !startAction;
    controls.hidden = false;
    setBusy(false);
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => void refreshStatus(), POLL_MS);
  }

  async function openDashboard(fastOnly) {
    await invoke("navigate_to_desktop_dashboard", { fastOnly });
  }

  async function applyStatus(next) {
    status = next;
    if (status.dashboard_ready) {
      await openDashboard(false);
      return;
    }
    switch (status.state) {
      case "background_permission_required":
        showControls(null, "Open System Settings");
        return;
      case "port_conflict":
        showControls(status.detail || "Mandible's port is in use.");
        return;
      case "starting":
        schedulePoll();
        return;
    }
    if (!autoStartAttempted && status.launch_mode === "on_demand") {
      autoStartAttempted = true;
      await handleStart();
    } else if (status.state === "gateway_unavailable" && !status.gateway_error) {
      schedulePoll();
    } else {
      showControls(status.gateway_error || status.detail, "Start Mandible");
    }
  }

  async function refreshStatus() {
    setBusy(true);
    try {
      await applyStatus(await invoke("daemon_status"));
    } catch (error) {
      showControls(String(error));
    }
  }

  async function handleStart() {
    window.clearTimeout(pollTimer);
    setBusy(true);
    try {
      const command = status?.state === "background_permission_required" ? "daemon_background_settings" : "daemon_start";
      const next = await invoke(command);
      await applyStatus(next);
    } catch (error) {
      showControls(String(error), "Start Mandible");
    }
  }

  async function startup() {
    if (navigationFailed) {
      showControls("The dashboard did not open.");
      return;
    }
    try {
      await openDashboard(true);
    } catch {
      await refreshStatus();
    }
  }

  startButton.addEventListener("click", () => {
    autoStartAttempted = true;
    void handleStart();
  });
  retryButton.addEventListener("click", () => {
    navigationFailed = false;
    controls.hidden = true;
    void startup();
  });

  document.getElementById("mandible-startup-frame")?.getBoundingClientRect();
  void invoke("desktop_frame_ready", { dashboard: false }).then(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      void invoke("desktop_frame_painted", { dashboard: false }).catch(console.error);
    }));
  }).catch(console.error);
  void startup();
})();
