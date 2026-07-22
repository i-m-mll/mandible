(function () {
  const START_STATES = new Set(["stopped", "stale_pid"]);
  const REDIRECT_DELAY_MS = 150;
  const POLL_MS = 1200;

  const statusCopy = document.getElementById("status-copy");
  const statusBadge = document.getElementById("status-badge");
  const statusMeta = document.getElementById("status-meta");
  const launchMode = document.getElementById("launch-mode");
  const pidFile = document.getElementById("pid-file");
  const logFile = document.getElementById("log-file");
  const startBtn = document.getElementById("start-btn");
  const retryBtn = document.getElementById("retry-btn");

  let pollTimer = null;
  let autoStartAttempted = false;

  function hasTauri() {
    return Boolean(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  }

  function setBusy(busy) {
    startBtn.disabled = busy;
    retryBtn.disabled = busy;
  }

  function copyForStatus(status) {
    if (!status) {
      return "Checking whether the local Mandible daemon is already running.";
    }
    if (status.healthy) {
      return "Mandible is healthy. Redirecting to the live dashboard.";
    }
    switch (status.state) {
      case "starting":
        return "Mandible is starting. This page will redirect once the health check passes.";
      case "port_conflict":
        return status.detail || "Another process is already listening on Mandible's port.";
      case "stale_pid":
        return status.detail || "Mandible left behind a stale pid file. Starting again should recover it.";
      case "stopped":
        return status.launch_mode === "manual"
          ? "Mandible is stopped. Start it manually from this screen."
          : "Mandible is stopped. The desktop shell can start it automatically.";
      default:
        return status.detail || "Mandible is not currently reachable.";
    }
  }

  function updateStatus(status) {
    statusBadge.textContent = status.state.replace(/_/g, " ");
    statusBadge.dataset.state = status.state;
    statusMeta.textContent = `port ${status.port}${status.pid ? ` • pid ${status.pid}` : ""}`;
    statusCopy.textContent = copyForStatus(status);
    launchMode.textContent = status.launch_mode;
    pidFile.textContent = status.pid_file || "-";
    logFile.textContent = status.log_file || "-";
    startBtn.style.display = status.healthy ? "none" : "";
    startBtn.textContent = status.state === "starting" ? "Starting…" : "Start daemon";
  }

  async function invoke(command, args) {
    return window.__TAURI__.core.invoke(command, args);
  }

  async function redirectToDashboard(status) {
    try {
      // Rust performs the one-time fragment navigation internally so the raw
      // bootstrap proof is never returned to JavaScript across Tauri IPC.
      const enrolled = await invoke("client_auth_enroll");
      if (enrolled === true) return;
    } catch {
      // A missing or invalid protected file must not become an anonymous
      // operator credential. Strict mode will keep mutations locked.
    }
    window.location.replace(`http://127.0.0.1:${status.port}`);
  }

  async function refreshStatus() {
    if (!hasTauri()) {
      window.location.replace("http://127.0.0.1:19420");
      return;
    }

    try {
      const status = await invoke("daemon_status");
      updateStatus(status);

      if (status.healthy) {
        window.setTimeout(() => {
          void redirectToDashboard(status);
        }, REDIRECT_DELAY_MS);
        return;
      }

      if (!autoStartAttempted && status.launch_mode === "on_demand" && START_STATES.has(status.state)) {
        autoStartAttempted = true;
        await handleStart();
        return;
      }

      if (status.state === "starting") {
        schedulePoll();
      } else {
        clearPoll();
        setBusy(false);
      }
    } catch (error) {
      statusBadge.textContent = "error";
      statusBadge.dataset.state = "port_conflict";
      statusCopy.textContent = String(error);
      setBusy(false);
    }
  }

  async function handleStart() {
    setBusy(true);
    try {
      const status = await invoke("daemon_start");
      updateStatus(status);
      if (status.healthy) {
        await redirectToDashboard(status);
        return;
      }
      schedulePoll();
    } catch (error) {
      statusCopy.textContent = String(error);
      setBusy(false);
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
    void handleStart();
  });
  retryBtn.addEventListener("click", () => {
    autoStartAttempted = false;
    void refreshStatus();
  });

  void refreshStatus();
})();
