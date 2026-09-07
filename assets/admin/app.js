/* atelier-api admin dashboard — vanilla client. Talks to /api/v1/admin/web/*
 * (cookie-authed). No build step. */
(() => {
  "use strict";
  const API = "/api/v1/admin/web";
  const view = document.getElementById("view");
  const titleEl = document.getElementById("title");
  const subEl = document.getElementById("subtitle");

  /* ----------------------------------------------------------- helpers */
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  function fmtBytes(n) {
    if (n == null) return "–";
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + " " + u[i];
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmtTime(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function fmtDate(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB") + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function ago(iso) {
    if (!iso) return "–";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return Math.floor(s / 86400) + " days ago";
  }

  let toastTimer;
  function toast(msg, kind) {
    let box = document.querySelector(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  async function api(path, opts) {
    const res = await fetch(API + path, { credentials: "same-origin", ...(opts || {}) });
    if (res.status === 401) { location.href = "/admin"; throw new Error("unauthorized"); }
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await res.json().catch(() => ({})) : null;
    if (!res.ok) throw new Error((body && body.error) || ("HTTP " + res.status));
    return body;
  }

  const STATUS_LABEL = { done: "done", error: "error", running: "running", queued: "queued" };
  function badge(status) {
    return '<span class="badge badge-' + esc(status) + '"><span class="dot"></span>' +
      esc(STATUS_LABEL[status] || status) + "</span>";
  }
  function loading() { view.innerHTML = '<div class="empty"><span class="spinner"></span></div>'; }
  function errorView(e) { view.innerHTML = '<div class="card"><div class="empty">Error: ' + esc(e.message) + "</div></div>"; }

  /* ----------------------------------------------------------- overview */
  async function viewOverview() {
    setHead("Overview", "Server status, storage and key metrics");
    loading();
    let d;
    try { d = await api("/overview"); } catch (e) { return errorView(e); }
    const c = d.counts, st = d.storage;
    const tile = (label, value, unit, extra) =>
      '<div class="stat"><div class="glow"></div><div class="label">' + esc(label) + "</div>" +
      '<div class="value">' + esc(value) + (unit ? '<span class="unit">' + esc(unit) + "</span>" : "") + "</div>" +
      (extra ? '<div class="extra">' + esc(extra) + "</div>" : "") + "</div>";
    view.innerHTML =
      '<div class="grid cols-4">' +
        tile("Total storage", fmtBytes(st.totalBytes), "", st.cas.files + st.builds.files + st.tmp.files + " files") +
        tile("Assets (CAS)", c.assets, "", fmtBytes(st.cas.bytes)) +
        tile("Builds", c.builds.done, "done", st.builds.files + " ZIPs · " + fmtBytes(st.builds.bytes)) +
        tile("Packs", c.packs, "", c.revisions + " revisions") +
      "</div>" +
      '<div class="grid cols-4" style="margin-top:18px">' +
        tile("Users", c.users.total, "", c.users.approved + " approved") +
        tile("Awaiting approval", c.users.pending, "", c.users.locked + " locked") +
        tile("Version", d.version, "", "up for " + uptime(d.uptimeSec)) +
        tile("tmp (uploads)", fmtBytes(st.tmp.bytes), "", st.tmp.files + " files") +
      "</div>" +
      '<div class="card" style="margin-top:18px"><div class="card-h"><h2>Storage breakdown</h2>' +
        '<span class="hint mono">' + esc(st.root) + "</span></div>" +
        bar("CAS assets", st.cas.bytes, st.totalBytes) +
        bar("Build artifacts", st.builds.bytes, st.totalBytes) +
        bar("Temporary (tmp)", st.tmp.bytes, st.totalBytes) +
      "</div>" +
      // Maintenance: notification status + storage cleanup (dry-run first).
      '<div class="card" style="margin-top:18px"><div class="card-h"><h2>Maintenance</h2>' +
        (d.notifierConfigured
          ? '<span class="chip on"><span class="dot"></span>Notifications on</span>'
          : '<span class="chip off" title="Set ATELIER_DISCORD_WEBHOOK_URL to enable Discord alerts">' +
            '<span class="dot"></span>Notifications off</span>') +
      "</div>" +
      '<div class="spread"><div><div style="font-size:13px;font-weight:500">Storage cleanup</div>' +
        '<div class="muted" style="font-size:12px;margin-top:2px;max-width:520px">Reclaim orphaned CAS assets ' +
        '(uploaded &gt; 48 h ago, never committed), stale tmp uploads and build ZIPs with no matching record. ' +
        'Scans read-only first — nothing is deleted until you confirm.</div></div>' +
        '<button class="btn" id="gcScan">Scan</button></div>' +
        '<div id="gcResult" style="margin-top:14px"></div>' +
      "</div>";
    const scanBtn = document.getElementById("gcScan");
    if (scanBtn) scanBtn.addEventListener("click", () => gcScan());
  }

  /* ------------------------------------------------------- storage GC */
  function gcLine(label, cat) {
    return '<div class="spread" style="margin:6px 0;font-size:13px">' +
      '<span>' + esc(label) + "</span>" +
      '<span class="muted mono" style="font-size:12px">' + cat.count + " item(s) · " + fmtBytes(cat.bytes) + "</span></div>";
  }
  async function gcScan() {
    const box = document.getElementById("gcResult");
    if (!box) return;
    box.innerHTML = '<span class="spinner"></span>';
    let r;
    try { r = await api("/storage/gc"); } catch (e) { box.innerHTML = '<div class="muted">' + esc(e.message) + "</div>"; return; }
    const summary = gcLine("Orphan CAS assets", r.orphanAssets) +
      gcLine("Stale tmp uploads", r.staleTmp) +
      gcLine("Orphan build ZIPs", r.orphanBuilds);
    if (r.totalCount === 0) {
      box.innerHTML = summary + '<div class="muted" style="margin-top:8px;font-size:12.5px">Nothing to reclaim — storage is clean. ✨</div>';
      return;
    }
    box.innerHTML = summary +
      '<div class="spread" style="margin-top:12px">' +
      '<span style="font-size:13px;font-weight:600">Reclaimable: ' + fmtBytes(r.totalBytes) + " (" + r.totalCount + " items)</span>" +
      '<button class="btn btn-primary" id="gcRun">Clean up now</button></div>';
    const runBtn = document.getElementById("gcRun");
    if (runBtn) runBtn.addEventListener("click", () => gcRun(runBtn));
  }
  async function gcRun(btn) {
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api("/storage/gc", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      toast("Reclaimed " + fmtBytes(r.totalBytes) + " (" + r.totalCount + " items)", "ok");
      viewOverview();
    } catch (e) { toast(e.message, "err"); btn.disabled = false; btn.textContent = "Clean up now"; }
  }
  function uptime(s) {
    if (s < 60) return Math.floor(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function bar(label, val, total) {
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    return '<div style="margin:12px 0"><div class="spread" style="margin-bottom:6px">' +
      '<span style="font-size:13px">' + esc(label) + "</span>" +
      '<span class="muted mono" style="font-size:12px">' + fmtBytes(val) + " · " + pct + "%</span></div>" +
      '<div style="height:8px;border-radius:8px;background:rgba(255,255,255,.06);overflow:hidden">' +
      '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#5865f2,#7289da)"></div></div></div>';
  }

  /* --------------------------------------------------------------- logs */
  let sse = null;
  function closeSse() { if (sse) { sse.close(); sse = null; } }

  async function viewLogs() {
    setHead("Logs", "Server logs (live) and activity log");
    view.innerHTML =
      '<div class="tabs"><div class="tab active" data-tab="server">Server logs</div>' +
      '<div class="tab" data-tab="activity">Activity</div></div><div id="logpane"></div>';
    view.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        view.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        t.dataset.tab === "server" ? logServer() : logActivity();
      }));
    logServer();
  }

  async function logServer() {
    closeSse();
    const pane = document.getElementById("logpane");
    pane.innerHTML = '<div class="card"><div class="card-h"><h2>Server logs</h2>' +
      '<span class="hint">live · last 500 lines</span></div><div class="logbox" id="logbox"></div></div>';
    const boxEl = document.getElementById("logbox");
    const render = (e) => {
      const atBottom = boxEl.scrollHeight - boxEl.scrollTop - boxEl.clientHeight < 40;
      const line = document.createElement("div");
      line.className = "log-line " + e.level;
      line.innerHTML = '<span class="t">' + fmtTime(e.ts) + '</span><span class="s">' + esc(e.scope) +
        '</span><span class="m">' + esc(e.msg) + "</span>";
      boxEl.appendChild(line);
      while (boxEl.childElementCount > 600) boxEl.firstChild.remove();
      if (atBottom) boxEl.scrollTop = boxEl.scrollHeight;
    };
    try {
      const d = await api("/logs");
      (d.items || []).forEach(render);
      boxEl.scrollTop = boxEl.scrollHeight;
    } catch (e) { boxEl.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; return; }
    // live tail
    sse = new EventSource(API + "/logs/stream");
    sse.onmessage = (ev) => { try { render(JSON.parse(ev.data)); } catch (_) {} };
    sse.onerror = () => {};
  }

  async function logActivity() {
    closeSse();
    const pane = document.getElementById("logpane");
    pane.innerHTML = '<div class="card"><div class="empty"><span class="spinner"></span></div></div>';
    let d;
    try { d = await api("/activity?limit=200"); } catch (e) { pane.innerHTML = '<div class="card"><div class="empty">' + esc(e.message) + "</div></div>"; return; }
    const rows = (d.items || []).map((a) =>
      "<tr><td class='muted mono'>" + fmtDate(a.ts) + "</td><td><b>" + esc(a.type) + "</b></td>" +
      "<td class='mono'>" + esc(a.actorDiscordId) + "</td><td class='muted mono' style='font-size:11px'>" +
      esc(JSON.stringify(a.data || {})) + "</td></tr>").join("");
    pane.innerHTML = '<div class="card"><div class="card-h"><h2>Activity</h2><span class="hint">' +
      (d.items ? d.items.length : 0) + " entries</span></div>" +
      (rows ? '<table class="table"><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead><tbody>' +
        rows + "</tbody></table>" : '<div class="empty">No activity yet.</div>') + "</div>";
  }

  /* -------------------------------------------------------------- packs */
  async function viewPacks() {
    setHead("Packs & Builds", "Create server builds and download packages");
    loading();
    let d;
    try { d = await api("/packs"); } catch (e) { return errorView(e); }
    if (!d.packs.length) { view.innerHTML = '<div class="card"><div class="empty">No packs yet.</div></div>'; return; }
    const rows = d.packs.map((p) =>
      '<tr style="cursor:pointer" data-pack="' + esc(p.packId) + '">' +
      "<td><b>" + esc(p.name) + "</b><div class='muted mono' style='font-size:11px'>" + esc(p.slug) + "</div></td>" +
      "<td class='mono'>" + esc(p.ownerDiscordId) + "</td>" +
      "<td>" + (p.headRevision || "–") + "</td>" +
      "<td>" + (p.hasBuildConfig ? '<span class="badge badge-running"><span class="dot"></span>custom</span>' : '<span class="muted">Default</span>') + "</td>" +
      "<td style='text-align:right'><span class='muted'>open ›</span></td></tr>").join("");
    view.innerHTML = '<div class="card"><div class="card-h"><h2>All packs</h2><span class="hint">' +
      d.packs.length + ' packs</span></div><table class="table"><thead><tr><th>Pack</th><th>Owner</th>' +
      "<th>Head rev</th><th>Build config</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    view.querySelectorAll("[data-pack]").forEach((r) =>
      r.addEventListener("click", () => { location.hash = "#pack/" + r.dataset.pack; }));
  }

  async function viewPack(packId) {
    setHead("Pack", "Builds & fxmanifest");
    loading();
    let d;
    try { d = await api("/packs/" + encodeURIComponent(packId)); } catch (e) { return errorView(e); }
    const p = d.pack;
    const cfg = d.buildConfig || {};
    const revRows = d.revisions.length ? d.revisions.map((r) => {
      const b = d.builds.find((x) => x.revision === r.revision);
      const dl = b && b.status === "done"
        ? '<a class="btn btn-sm btn-primary" href="' + API + "/builds/" + esc(b.buildId) + '/download">Download ZIP</a>' : "";
      const st = b ? badge(b.status) : '<span class="muted">no build</span>';
      const sz = b && b.sizeBytes ? "<span class='muted mono' style='font-size:11px'>" + fmtBytes(b.sizeBytes) + "</span>" : "";
      return "<tr><td><b>r" + r.revision + "</b>" + (r.revision === p.headRevision ? ' <span class="badge badge-done"><span class="dot"></span>head</span>' : "") +
        "<div class='muted' style='font-size:11px'>" + esc(r.message || "") + "</div></td>" +
        "<td>" + (r.drawableCount != null ? r.drawableCount : "–") + "</td>" +
        "<td class='muted mono' style='font-size:11px'>" + esc(r.dlcName || "–") + "</td>" +
        "<td>" + st + " " + sz + "</td>" +
        "<td style='text-align:right'><div class='row' style='justify-content:flex-end'>" +
        '<button class="btn btn-sm" data-build="' + r.revision + '">' + (b ? "rebuild" : "build") + "</button>" + dl +
        "</div></td></tr>";
    }).join("") : "";
    view.innerHTML =
      '<div class="back" id="back">‹ back to packs</div>' +
      '<div class="card"><div class="card-h"><h2>' + esc(p.name) + '</h2><span class="hint mono">' + esc(p.slug) + "</span></div>" +
      (revRows ? '<table class="table"><thead><tr><th>Revision</th><th>Drawables</th><th>DLC</th><th>Build</th><th></th></tr></thead><tbody>' +
        revRows + "</tbody></table>" : '<div class="empty">This pack has no revisions yet.</div>') + "</div>" +
      // fxmanifest editor
      '<div class="card"><div class="card-h"><h2>fxmanifest & build config</h2>' +
        '<span class="hint">applies to server builds of this pack</span></div>' +
        '<div class="field"><label>Resource name (optional)</label>' +
        '<input type="text" id="resName" placeholder="Default: DLC name" value="' + esc(cfg.resourceName || "") + '">' +
        '<div class="desc">Overrides the folder / resource name. Empty = default.</div></div>' +
        '<div class="field"><label>fxmanifest.lua template</label>' +
        '<textarea id="fxTpl" spellcheck="false" placeholder="' + esc(d.defaultTemplate) + '">' + esc(cfg.fxmanifestTemplate || "") + "</textarea>" +
        '<div class="desc">Placeholders <span class="mono">{{files}}</span> (stream globs) and <span class="mono">{{data_files}}</span> ' +
        '(shop-meta lines) are substituted at build time. Empty = default manifest (byte-identical to the desktop build).</div></div>' +
        '<div class="row"><button class="btn btn-primary" id="saveCfg">Save</button>' +
        '<button class="btn" id="rebuildCfg">Save & rebuild head</button>' +
        '<button class="btn" id="loadDefault">Insert default</button>' +
        '<button class="btn" id="resetCfg">Reset</button></div>' +
      "</div>";
    document.getElementById("back").addEventListener("click", () => { location.hash = "#packs"; });
    view.querySelectorAll("[data-build]").forEach((btn) =>
      btn.addEventListener("click", () => triggerBuild(packId, Number(btn.dataset.build), btn)));
    document.getElementById("loadDefault").addEventListener("click", () => { document.getElementById("fxTpl").value = d.defaultTemplate; });
    document.getElementById("saveCfg").addEventListener("click", () => saveCfg(packId, false));
    document.getElementById("rebuildCfg").addEventListener("click", () => saveCfg(packId, true, p.headRevision));
    document.getElementById("resetCfg").addEventListener("click", () => resetCfg(packId));
  }

  async function saveCfg(packId, rebuild, headRev) {
    const resourceName = document.getElementById("resName").value.trim();
    const fxmanifestTemplate = document.getElementById("fxTpl").value;
    try {
      await api("/packs/" + encodeURIComponent(packId) + "/build-config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceName, fxmanifestTemplate }),
      });
      toast("Build config saved", "ok");
      if (rebuild) {
        if (!headRev) { toast("No revision to build", "err"); return; }
        await api("/packs/" + encodeURIComponent(packId) + "/builds", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: "head", force: true }),
        });
        toast("New build started — see the Build tab shortly", "ok");
      }
      viewPack(packId);
    } catch (e) { toast(e.message, "err"); }
  }
  async function resetCfg(packId) {
    try {
      await api("/packs/" + encodeURIComponent(packId) + "/build-config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceName: "", fxmanifestTemplate: "" }),
      });
      toast("Reset to default", "ok"); viewPack(packId);
    } catch (e) { toast(e.message, "err"); }
  }
  async function triggerBuild(packId, revision, btn) {
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api("/packs/" + encodeURIComponent(packId) + "/builds", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, force: true }),
      });
      toast("Build " + (r.build.status === "done" ? "done" : "started") + " (r" + revision + ")", "ok");
      pollPack(packId);
    } catch (e) { toast(e.message, "err"); btn.disabled = false; btn.textContent = "build"; }
  }
  // Refresh the pack view a few times so queued/running builds settle to done.
  let pollTimer;
  function pollPack(packId) {
    clearInterval(pollTimer);
    let n = 0;
    pollTimer = setInterval(async () => {
      if (location.hash !== "#pack/" + packId || ++n > 12) { clearInterval(pollTimer); return; }
      try {
        const d = await api("/packs/" + encodeURIComponent(packId));
        const inFlight = d.builds.some((b) => b.status === "queued" || b.status === "running");
        if (!inFlight) { clearInterval(pollTimer); viewPack(packId); }
      } catch (_) { clearInterval(pollTimer); }
    }, 2500);
    viewPack(packId);
  }

  /* ------------------------------------------------------------- builds */
  async function viewBuilds() {
    setHead("Packages", "All server builds available for download");
    loading();
    let d;
    try { d = await api("/builds"); } catch (e) { return errorView(e); }
    if (!d.builds.length) { view.innerHTML = '<div class="card"><div class="empty">No builds created yet.</div></div>'; return; }
    const rows = d.builds.map((b) =>
      "<tr><td><b>" + esc(b.packName || b.packId) + "</b></td><td>r" + b.revision + "</td><td>" + badge(b.status) + "</td>" +
      "<td class='mono'>" + (b.sizeBytes ? fmtBytes(b.sizeBytes) : "–") + "</td>" +
      "<td class='muted'>" + ago(b.finishedAt) + "</td><td style='text-align:right'>" +
      (b.status === "done" ? '<a class="btn btn-sm btn-primary" href="' + API + "/builds/" + esc(b.buildId) + '/download">Download ZIP</a>' :
        b.status === "error" ? "<span class='muted' title='" + esc(b.error || "") + "'>failed</span>" : "<span class='muted'>…</span>") +
      "</td></tr>").join("");
    view.innerHTML = '<div class="card"><div class="card-h"><h2>Server builds</h2><span class="hint">' +
      d.builds.length + ' builds</span></div><table class="table"><thead><tr><th>Pack</th><th>Rev</th><th>Status</th>' +
      "<th>Size</th><th>Finished</th><th></th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  }

  /* -------------------------------------------------------------- users */
  let usersCache = [];
  const usersFilter = { status: "all", q: "" };

  async function viewUsers() {
    setHead("Users", "Approvals, locks and roles");
    loading();
    let d;
    try { d = await api("/users"); } catch (e) { return errorView(e); }
    usersCache = d.users || [];

    const counts = { all: usersCache.length, pending: 0, approved: 0, locked: 0 };
    for (const u of usersCache) counts[u.status] = (counts[u.status] || 0) + 1;
    const seg = (key, label) =>
      '<button class="' + (usersFilter.status === key ? "active" : "") + '" data-status="' + key + '">' +
      esc(label) + '<span class="count">' + counts[key] + "</span></button>";

    view.innerHTML =
      '<div class="filterbar"><div class="search field" style="margin:0">' +
        '<input type="text" id="userSearch" placeholder="Search name or Discord ID…" value="' + esc(usersFilter.q) + '"></div>' +
        '<div class="seg">' + seg("all", "All") + seg("pending", "Pending") + seg("approved", "Approved") + seg("locked", "Locked") + "</div>" +
      "</div>" +
      '<div class="card"><div class="card-h"><h2>Users</h2><span class="hint" id="usersHint"></span></div>' +
      '<div id="usersTable"></div></div>';

    const search = document.getElementById("userSearch");
    search.addEventListener("input", () => { usersFilter.q = search.value; paintUsers(); });
    view.querySelectorAll(".seg button").forEach((b) =>
      b.addEventListener("click", () => {
        usersFilter.status = b.dataset.status;
        view.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("active", x === b));
        paintUsers();
      }));
    paintUsers();
  }

  function paintUsers() {
    const container = document.getElementById("usersTable");
    if (!container) return;
    const q = usersFilter.q.trim().toLowerCase();
    const list = usersCache.filter((u) =>
      (usersFilter.status === "all" || u.status === usersFilter.status) &&
      (!q || u.username.toLowerCase().includes(q) || u.discordId.includes(q)));

    const hint = document.getElementById("usersHint");
    if (hint) hint.textContent = list.length + " of " + usersCache.length;

    if (!list.length) { container.innerHTML = '<div class="empty">No users match.</div>'; return; }
    const rows = list.map((u) => {
      const av = u.avatar ? '<img src="' + esc(u.avatar) + '" style="width:26px;height:26px;border-radius:50%">' :
        '<div style="width:26px;height:26px;border-radius:50%;background:#5865f2"></div>';
      const st = u.status === "approved" ? '<span class="badge badge-done"><span class="dot"></span>approved</span>' :
        u.status === "locked" ? '<span class="badge badge-error"><span class="dot"></span>locked</span>' :
        '<span class="badge badge-queued"><span class="dot"></span>pending</span>';
      const targetRole = u.role === "admin" ? "member" : "admin";
      let act = "";
      if (u.status !== "approved") act += '<button class="btn btn-sm btn-primary" data-approve="' + esc(u.discordId) + '">approve</button> ';
      if (u.status !== "locked") act += '<button class="btn btn-sm" data-lock="' + esc(u.discordId) + '">lock</button> ';
      act += '<button class="btn btn-sm" data-role="' + esc(u.discordId) + '" data-target="' + targetRole + '">' +
        (targetRole === "admin" ? "make admin" : "make member") + "</button>";
      return "<tr><td><div class='row'>" + av + "<b>" + esc(u.username) + "</b></div></td>" +
        "<td class='mono'>" + esc(u.discordId) + "</td><td>" + st + "</td>" +
        "<td>" + (u.role === "admin" ? '<span class="badge badge-running"><span class="dot"></span>admin</span>' : "member") + "</td>" +
        "<td style='text-align:right'><div class='row' style='justify-content:flex-end'>" + act + "</div></td></tr>";
    }).join("");
    container.innerHTML = '<table class="table"><thead><tr><th>Name</th><th>Discord ID</th>' +
      "<th>Status</th><th>Role</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>";

    const post = async (id, path, body, label) => {
      try {
        await api("/users/" + encodeURIComponent(id) + path, {
          method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : "{}",
        });
        toast(label, "ok"); refreshPendingBadge(); viewUsers();
      } catch (e) { toast(e.message, "err"); }
    };
    container.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => post(b.dataset.approve, "/approve", null, "Approved")));
    container.querySelectorAll("[data-lock]").forEach((b) => b.addEventListener("click", () => post(b.dataset.lock, "/lock", null, "Locked")));
    container.querySelectorAll("[data-role]").forEach((b) =>
      b.addEventListener("click", () => post(b.dataset.role, "/role", { role: b.dataset.target }, "Role changed to " + b.dataset.target)));
  }

  /* --------------------------------------------------- pending badge */
  // Live count of users awaiting approval, shown on the Users nav item so an
  // admin sees at a glance that someone is waiting — without opening the tab.
  async function refreshPendingBadge() {
    const badge = document.getElementById("navBadgeUsers");
    if (!badge) return;
    try {
      const d = await api("/users?status=pending");
      const n = (d.users || []).length;
      if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
      else { badge.hidden = true; }
    } catch (_) { /* leave the badge as-is on a transient error */ }
  }

  /* ------------------------------------------------------------- router */
  function setHead(title, sub) { titleEl.textContent = title; subEl.textContent = sub || ""; }
  function setActive(route) {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.route === route));
  }

  function route() {
    closeSse();
    const h = location.hash.replace(/^#/, "") || "overview";
    if (h.startsWith("pack/")) { setActive("packs"); return viewPack(h.slice(5)); }
    setActive(h);
    switch (h) {
      case "logs": return viewLogs();
      case "packs": return viewPacks();
      case "builds": return viewBuilds();
      case "users": return viewUsers();
      default: return viewOverview();
    }
  }

  document.querySelectorAll(".nav-item").forEach((n) =>
    n.addEventListener("click", () => { location.hash = "#" + n.dataset.route; }));
  window.addEventListener("hashchange", route);
  route();
  refreshPendingBadge();
  // Keep the pending badge fresh even if the admin sits on another tab.
  setInterval(refreshPendingBadge, 60000);
})();
