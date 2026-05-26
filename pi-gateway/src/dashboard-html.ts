export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pi Gateway Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117; color: #c9d1d9; padding: 16px; min-height: 100vh;
    }
    header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #21262d;
    }
    header h1 { font-size: 18px; font-weight: 600; color: #58a6ff; }
    header span { font-size: 13px; color: #8b949e; }
    .cards {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px; margin-bottom: 16px;
    }
    .card {
      background: #161b22; border: 1px solid #21262d; border-radius: 6px;
      padding: 14px 16px;
    }
    .card .label { font-size: 11px; text-transform: uppercase; color: #8b949e; letter-spacing: 0.5px; }
    .card .value { font-size: 26px; font-weight: 700; margin-top: 4px; }
    .card .sub  { font-size: 11px; color: #484f58; margin-top: 2px; }
    .alert { color: #f85149 !important; }
    .section {
      background: #161b22; border: 1px solid #21262d; border-radius: 6px;
      margin-bottom: 12px; overflow: hidden;
    }
    .section-title {
      padding: 10px 14px; font-size: 13px; font-weight: 600;
      background: #1c2128; border-bottom: 1px solid #21262d;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 14px; text-align: left; border-bottom: 1px solid #21262d; }
    th { font-weight: 500; color: #8b949e; background: #0d1117; position: sticky; top: 0; }
    tr:hover td { background: #1c2128; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
    }
    .badge-streaming  { background: #1f6feb33; color: #58a6ff; }
    .badge-compacting { background: #d2992233; color: #d29922; }
    .badge-idle       { background: #23863633; color: #3fb950; }
    .detail-row td { padding: 4px 14px; font-size: 12px; color: #8b949e; background: #0d1117; }
    .event-row { font-size: 12px; }
    .event-row td { padding: 4px 14px; }
    .events-container { max-height: 260px; overflow-y: auto; }
    button {
      background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
      padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer;
    }
    button:hover { background: #30363d; }
    .status-bar {
      display: flex; gap: 16px; padding: 10px 14px; font-size: 12px; color: #8b949e;
      border-top: 1px solid #21262d;
    }
    .status-bar span { display: flex; align-items: center; gap: 4px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .dot-green  { background: #3fb950; }
    .dot-yellow { background: #d29922; }
    .dot-red    { background: #f85149; }
  </style>
</head>
<body>
  <header>
    <h1>pi Gateway Admin</h1>
    <span id="uptime">uptime: --</span>
  </header>

  <div class="cards">
    <div class="card">
      <div class="label">Active Sessions</div>
      <div class="value" id="val-sessions">--</div>
      <div class="sub" id="sub-sessions">max 50</div>
    </div>
    <div class="card">
      <div class="label">Total Prompts</div>
      <div class="value" id="val-prompts">--</div>
    </div>
    <div class="card">
      <div class="label">Total Errors</div>
      <div class="value" id="val-errors">--</div>
    </div>
    <div class="card">
      <div class="label">Gateway Memory</div>
      <div class="value" id="val-memory">--</div>
      <div class="sub" id="sub-memory">system: --%</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Sessions</div>
    <table id="sessions-table">
      <thead>
        <tr>
          <th></th>
          <th>ID</th>
          <th>Status</th>
          <th>Model</th>
          <th>Messages</th>
          <th>Memory</th>
          <th>Idle</th>
        </tr>
      </thead>
      <tbody id="sessions-body"></tbody>
    </table>
    <div class="status-bar" id="sessions-status"></div>
  </div>

  <div class="section">
    <div class="section-title">Recent Events</div>
    <div class="events-container">
      <table>
        <tbody id="events-body"></tbody>
      </table>
    </div>
  </div>

  <script>
    let expandedSessions = new Set();

    function toggleSession(id) {
      if (expandedSessions.has(id)) expandedSessions.delete(id);
      else expandedSessions.add(id);
    }

    function formatTime(ts) {
      if (!ts) return "--";
      const d = new Date(ts);
      return d.toLocaleTimeString();
    }

    function formatIdle(ms) {
      if (!ms) return "--";
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      if (m > 0) return m + "m " + s + "s";
      return s + "s";
    }

    function statusBadge(status) {
      const cls = "badge badge-" + status;
      return '<span class="' + cls + '">' + status + '</span>';
    }

    async function refresh() {
      try {
        const [metricsRes, sessionsRes] = await Promise.all([
          fetch("/admin/api/metrics"),
          fetch("/admin/api/sessions"),
        ]);
        const metrics = await metricsRes.json();
        const { sessions } = await sessionsRes.json();

        document.getElementById("uptime").textContent =
          "uptime: " + formatTime(Date.now() - (metrics.uptime * 1000));

        const alertClass = metrics.activeSessions > metrics.maxSessions * 0.9 ? " alert" : "";
        document.getElementById("val-sessions").innerHTML =
          '<span class="' + alertClass + '">' + metrics.activeSessions + "</span>";
        document.getElementById("sub-sessions").textContent = "max " + metrics.maxSessions;

        document.getElementById("val-prompts").textContent = metrics.totalPrompts;
        document.getElementById("val-errors").textContent = metrics.totalErrors;

        document.getElementById("val-memory").textContent = "~" + metrics.gatewayMemoryMB + " MB";
        document.getElementById("sub-memory").textContent =
          "system: " + metrics.systemMemoryPercent + "%";

        const tbody = document.getElementById("sessions-body");
        const now = Date.now();
        tbody.innerHTML = sessions.map(function(s) {
          var rows = '<tr style="cursor:pointer" onclick="toggleSession(\\'' + s.sessionId + '\\')">';
          rows += '<td style="width:20px">' + (expandedSessions.has(s.sessionId) ? "\\u25BC" : "\\u25B6") + "</td>";
          rows += '<td style="font-family:monospace;font-size:12px">' + s.sessionId.slice(0, 12) + "...</td>";
          rows += "<td>" + statusBadge(s.status) + "</td>";
          rows += "<td>" + s.model + "</td>";
          rows += "<td>" + s.messageCount + "</td>";
          rows += "<td>" + s.memoryMB + " MB</td>";
          rows += "<td>" + formatIdle(now - s.lastActivityAt) + "</td>";
          rows += "</tr>";

          if (expandedSessions.has(s.sessionId)) {
            rows += '<tr class="detail-row"><td></td><td colspan="6">';
            rows += "cwd: " + s.cwd + " | ";
            rows += "thinking: " + s.thinkingLevel + " | ";
            rows += "compact: " + (s.autoCompactionEnabled ? "on" : "off") + " | ";
            rows += "retry: " + (s.autoRetryEnabled ? "on" : "off");
            if (s.steeringQueue.length) {
              rows += '<br>steering queue (' + s.steeringQueue.length + '): ';
              rows += s.steeringQueue.map(function(m) { return '"' + m + '"'; }).join(", ");
            }
            if (s.followUpQueue.length) {
              rows += '<br>followUp queue (' + s.followUpQueue.length + '): ';
              rows += s.followUpQueue.map(function(m) { return '"' + m + '"'; }).join(", ");
            }
            if (s.pendingUiQuestions) {
              rows += '<br>pending UI questions: ' + s.pendingUiQuestions;
            }
            rows += "</td></tr>";
          }
          return rows;
        }).join("");

        const st = document.getElementById("sessions-status");
        var streaming = sessions.filter(function(s) { return s.status === "streaming"; }).length;
        var idle = sessions.filter(function(s) { return s.status === "idle"; }).length;
        var compacting = sessions.filter(function(s) { return s.status === "compacting"; }).length;
        st.innerHTML =
          '<span><span class="dot dot-green"></span> idle: ' + idle + "</span>" +
          '<span><span class="dot dot-yellow"></span> streaming: ' + streaming + "</span>" +
          '<span><span class="dot dot-red"></span> compacting: ' + compacting + "</span>" +
          '<span>total: ' + sessions.length + "</span>";

        const ebody = document.getElementById("events-body");
        ebody.innerHTML = (metrics.events || []).slice().reverse().map(function(e) {
          return '<tr class="event-row">' +
            "<td>" + formatTime(e.timestamp) + "</td>" +
            '<td style="font-family:monospace;font-size:11px">' + (e.sessionId || "--").slice(0, 12) + "</td>" +
            "<td>" + e.type + "</td>" +
            "<td>" + e.detail + "</td>" +
            "</tr>";
        }).join("");
      } catch (err) {
        console.error("refresh error:", err);
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}
