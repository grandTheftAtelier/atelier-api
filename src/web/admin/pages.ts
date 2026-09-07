/**
 * HTML for the /admin web dashboard: the login page (Discord button) and the
 * dashboard shell (sidebar + topbar + #view mount). The interactive parts load
 * from the static assets /admin/app.css + /admin/app.js, so this file only
 * ships the markup + the server-rendered session identity.
 */

import type { AdminWebSession } from "../../auth/admin-web";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const DISCORD_MARK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.2.36-.43.84-.59 1.23a18.27 18.27 0 0 0-5.93 0A12.6 12.6 0 0 0 9.44 3a19.7 19.7 0 0 0-3.76 1.37C2.93 8.01 2.27 11.55 2.5 15.05a19.9 19.9 0 0 0 6.07 3.08c.49-.67.93-1.38 1.3-2.13-.71-.27-1.39-.6-2.03-.99.17-.13.34-.26.5-.4 3.92 1.83 8.16 1.83 12.03 0 .17.14.33.27.5.4-.64.39-1.32.72-2.03.99.37.75.81 1.46 1.3 2.13a19.85 19.85 0 0 0 6.07-3.08c.27-4.05-.54-7.56-2.9-10.68ZM9.68 13.1c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.1 2.15 2.42 0 1.34-.95 2.42-2.15 2.42Zm4.64 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.2 0 2.17 1.1 2.15 2.42 0 1.34-.94 2.42-2.15 2.42Z"/></svg>`;

const NAV_ICONS: Record<string, string> = {
  overview: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>`,
  logs: `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
  packs: `<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>`,
  builds: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
  users: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
};

function navItem(route: string, label: string): string {
  // The users item carries a live "pending approvals" badge (filled by app.js).
  const badge = route === "users" ? `<span class="nav-badge" id="navBadgeUsers" hidden></span>` : "";
  return `<div class="nav-item" data-route="${route}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[route]}</svg>
    <span>${label}</span>${badge}</div>`;
}

/** The dashboard shell. The session identity is rendered server-side (escaped). */
export function renderAdminDashboard(
  session: AdminWebSession,
  version: string,
  update?: { updateAvailable: boolean; latest: string | null },
): string {
  const avatar = session.avatar
    ? `<img class="avatar" src="${escapeHtml(session.avatar)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="avatar"></div>`;
  const updateBadge = update?.updateAvailable
    ? `<a href="https://github.com/feelgoodrp-com/atelier-api" target="_blank" rel="noreferrer"
         title="Redeploy this server to update"
         style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;text-decoration:none;color:#fbbf24;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.35);border-radius:999px;padding:4px 11px">
         <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24"></span>Update available${update.latest ? ` · v${escapeHtml(update.latest)}` : ""}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>atelier-api — Admin</title>
<link rel="icon" href="/logo.png" />
<link rel="stylesheet" href="/admin/app.css" />
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><img src="/logo.png" alt="" /><div><b>atelier</b> <span>admin</span></div></div>
    <nav class="nav">
      ${navItem("overview", "Overview")}
      ${navItem("logs", "Logs")}
      ${navItem("packs", "Packs &amp; Builds")}
      ${navItem("builds", "Packages")}
      ${navItem("users", "Users")}
    </nav>
    <div class="sidebar-foot">
      <div class="who">
        ${avatar}
        <div class="meta"><div class="name">${escapeHtml(session.username)}</div><div class="role">Administrator</div></div>
      </div>
      <a class="nav-item" href="/admin/logout" style="margin-top:6px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span>Sign out</span></a>
    </div>
  </aside>
  <main class="main">
    <div class="topbar"><div><h1 id="title">Overview</h1><div class="sub" id="subtitle"></div></div>
      <div class="row" style="gap:8px">${updateBadge}<span class="badge badge-done"><span class="dot"></span>v${escapeHtml(version)}</span></div></div>
    <div class="content"><div id="view"></div></div>
  </main>
</div>
<script src="/admin/app.js"></script>
</body>
</html>`;
}

/** The login page (Discord button). `error` shows a styled notice (e.g. not an admin). */
export function renderAdminLogin(opts: { error?: string } = {}): string {
  const notice = opts.error
    ? `<div class="notice">${escapeHtml(opts.error)}</div>`
    : `<p class="message">This area is for administrators only. Sign in with your Discord account.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>atelier-api — Admin login</title>
<link rel="icon" href="/logo.png" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body { background: #0b0b0b; color: #fff; font-family: "Sora", "Segoe UI", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
  .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
  .veil { position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: linear-gradient(to bottom, rgba(11,11,11,.78), rgba(11,11,11,.62) 45%, rgba(11,11,11,.92)); }
  .grid { position: absolute; inset: 0; z-index: 0; opacity: .5; pointer-events: none;
    background-image: linear-gradient(rgba(255,255,255,.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.03) 1px, transparent 1px); background-size: 50px 50px; }
  .stage { position: relative; z-index: 1; width: 100%; max-width: 1040px; padding: 0 56px;
    display: flex; align-items: center; justify-content: space-between; gap: 56px; }
  .brand { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; animation: rise .5s ease-out both; }
  .brand .logo { width: 100px; height: 100px; }
  .wordmark { display: flex; align-items: baseline; gap: 12px; }
  .wordmark b { font-size: 44px; font-weight: 600; letter-spacing: -.02em; line-height: 1; }
  .wordmark span { font-size: 15px; font-weight: 500; color: #7289DA; }
  .adminchip { font-size: 11px; color: rgba(255,255,255,.5); background: rgba(88,101,242,.15);
    border: 1px solid rgba(88,101,242,.3); border-radius: 999px; padding: 3px 10px; }
  .tag { font-size: 15px; line-height: 1.5; color: rgba(255,255,255,.55); max-width: 340px; }
  .card { position: relative; background: rgba(0,0,0,.55); backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid rgba(255,255,255,.12);
    border-radius: 20px; padding: 36px 40px; width: 380px; flex-shrink: 0;
    animation: rise .5s ease-out .08s both; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); } }
  .card h1 { font-size: 20px; font-weight: 600; margin-bottom: 10px; }
  .message { font-size: 13.5px; line-height: 1.6; color: rgba(255,255,255,.55); margin-bottom: 22px; }
  .notice { font-size: 13px; line-height: 1.55; color: #fca5a5; background: rgba(248,113,113,.1);
    border: 1px solid rgba(248,113,113,.3); border-radius: 12px; padding: 12px 14px; margin-bottom: 22px; }
  .discord-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    padding: 13px; border-radius: 12px; background: #5865F2; color: #fff; font-weight: 600; font-size: 14.5px;
    border: none; cursor: pointer; text-decoration: none; transition: background .15s ease; }
  .discord-btn:hover { background: #4752C4; }
  .foot { margin-top: 22px; font-size: 10.5px; color: rgba(255,255,255,.25); text-align: center; }
  @media (max-width: 780px) {
    .stage { flex-direction: column; gap: 32px; padding: 0 24px; text-align: center; }
    .brand { align-items: center; } .tag { display: none; } .card { width: 100%; max-width: 400px; }
  }
  @media (prefers-reduced-motion: reduce) { .brand, .card { animation: none; } }
</style>
</head>
<body>
  <video class="bg" autoplay loop muted playsinline aria-hidden="true">
    <source src="/hero.webm" type="video/webm" /></video>
  <div class="veil"></div><div class="grid"></div>
  <div class="stage">
    <div class="brand">
      <img class="logo" src="/logo.png" alt="" draggable="false" />
      <div class="wordmark"><b>atelier</b><span>by feelgood</span><span class="adminchip">Admin</span></div>
      <p class="tag">Sync server administration — logs, storage, builds.</p>
    </div>
    <main class="card">
      <h1>Admin login</h1>
      ${notice}
      <a class="discord-btn" href="/admin/login">${DISCORD_MARK}<span>Sign in with Discord</span></a>
      <div class="foot">atelier-api</div>
    </main>
  </div>
</body>
</html>`;
}

/**
 * Defense-in-depth headers for the admin pages. The dashboard loads only its
 * own /admin/app.{css,js} (script-src 'self', no inline scripts) plus inline
 * styles (style attributes) and the Discord avatar; frame-ancestors 'none'
 * blocks clickjacking of the admin UI.
 */
const ADMIN_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; media-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Full HTML response helper for the admin pages. */
export function adminHtml(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...ADMIN_SECURITY_HEADERS,
      ...(headers ?? {}),
    },
  });
}
