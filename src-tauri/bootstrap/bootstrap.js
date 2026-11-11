(function () {
  const POLL_MS = 1200;
  const statusCopy = document.getElementById("status-copy");
  const statusBadge = document.getElementById("status-badge");
  const statusMeta = document.getElementById("status-meta");
  const launchMode = document.getElementById("launch-mode");
  const pidFile = document.getElementById("pid-file");
  const logFile = document.getElementById("log-file");
  const gatewayLogFile = document.getElementById("gateway-log-file");
  const startBtn = document.getElementById("start-btn");
  const retryBtn = document.getElementById("retry-btn");
  const query = new URLSearchParams(window.location.search);
  const skipAutoStart = query.get("skip_autostart") === "1";
  let navigationFailed = query.get("dashboard_navigation_failed") === "1";

  let pollTimer = null;
  let autoStartAttempted = skipAutoStart;
  let navigationPending = false;

  function hasTauri() {
    return Boolean(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  }

  function setBusy(busy) {
    startBtn.disabled = busy || statusBadge.dataset.state === "port_conflict";
    retryBtn.disabled = busy;
  }

  function copyForStatus(status) {
    if (!status) return "Checking the local Mandible services.";
    if (status.dashboard_ready) return "The backend and trusted dashboard are ready. Opening Mandible.";
    if (status.healthy) {
      return status.gateway_error
        ? `The backend is healthy, but the secure dashboard is unavailable. ${status.gateway_error}`
        : "The backend is healthy, but the secure dashboard is still starting.";
    }
    switch (status.state) {
      case "background_permission_required":
        return "Allow Mandible in System Settings → General → Login Items & Extensions to run its background services.";
      case "starting":
        return "Mandible is starting. This screen will continue checking both services.";
      case "port_conflict":
        return status.detail || "Another process is using a required Mandible port. No process was stopped.";
      case "stopped":
        return status.launch_mode === "manual"
          ? "Mandible is stopped. Start it explicitly from this screen."
          : "Mandible is stopped. The desktop shell can start it on demand.";
      default:
        return status.detail || "The local Mandible services are not ready yet.";
    }
  }

  function updateStatus(status) {
    statusBadge.textContent = status.dashboard_ready ? "dashboard ready" : status.state.replace(/_/g, " ");
    statusBadge.dataset.state = status.dashboard_ready ? "running" : status.state;
    statusMeta.textContent = `backend ${status.healthy ? "healthy" : "unavailable"} · port ${status.port} · dashboard ${status.gateway_state}`;
    statusCopy.textContent = copyForStatus(status);
    launchMode.textContent = status.launch_mode;
    pidFile.textContent = status.pid_file || "-";
    logFile.textContent = status.log_file || "-";
    gatewayLogFile.textContent = status.gateway_log_file || "-";
    startBtn.style.display = status.dashboard_ready ? "none" : "";
    startBtn.disabled = status.state === "port_conflict";
    startBtn.textContent = status.state === "background_permission_required" ? "Open System Settings"
      : status.state === "starting" ? "Starting…" : "Start Mandible";
  }

  async function invoke(command, args) {
    return window.__TAURI__.core.invoke(command, args);
  }

  async function openDashboard() {
    if (navigationPending) return;
    navigationPending = true;
    try {
      await invoke("navigate_to_desktop_dashboard");
    } catch (error) {
      navigationPending = false;
      navigationFailed = true;
      statusCopy.textContent = `The dashboard could not be opened: ${String(error)}`;
      return;
    }
  }

  async function refreshStatus() {
    if (!hasTauri()) {
      statusBadge.textContent = "desktop controller unavailable";
      statusBadge.dataset.state = "port_conflict";
      statusCopy.textContent = "Mandible could not reach its native runtime controller. Reopen the desktop app to retry.";
      setBusy(false);
      return;
    }

    try {
      const status = await invoke("daemon_status");
      updateStatus(status);
      if (navigationFailed) {
        statusCopy.textContent = "The dashboard page did not finish loading. Check the connection, then choose Retry to open it again.";
        setBusy(false);
        return;
      }
      if (status.dashboard_ready) {
        await openDashboard();
        return;
      }

      if (!autoStartAttempted && status.launch_mode === "on_demand" && status.state !== "port_conflict") {
        autoStartAttempted = true;
        await handleStart();
        return;
      }

      if (status.state === "starting" || status.state === "gateway_unavailable") {
        schedulePoll();
      } else {
        clearPoll();
        setBusy(false);
      }
    } catch (error) {
      statusBadge.textContent = "error";
      statusBadge.dataset.state = "error";
      statusCopy.textContent = String(error);
      setBusy(false);
      schedulePoll();
    }
  }

  async function handleStart() {
    clearPoll();
    setBusy(true);
    try {
      const status = await invoke(statusBadge.dataset.state === "background_permission_required" ? "daemon_background_settings" : "daemon_start");
      updateStatus(status);
      if (status.dashboard_ready) {
        await openDashboard();
        return;
      }
      schedulePoll();
    } catch (error) {
      statusCopy.textContent = String(error);
      setBusy(false);
      schedulePoll();
    }
  }

  function clearPoll() {
    if (pollTimer != null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    clearPoll();
    pollTimer = window.setTimeout(() => {
      void refreshStatus();
    }, POLL_MS);
  }

  startBtn.addEventListener("click", () => {
    autoStartAttempted = true;
    void handleStart();
  });
  retryBtn.addEventListener("click", () => {
    navigationFailed = false;
    void refreshStatus();
  });

  void refreshStatus();
})();
