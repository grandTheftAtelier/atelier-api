/**
 * Server-rendered API reference at GET /docs. Built straight from the OpenAPI
 * object so it never drifts, with zero client JS and zero external assets — it
 * renders under the strictest CSP. For tooling, the machine-readable spec lives
 * at /openapi.json.
 */

function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const METHOD_COLORS: Record<string, string> = {
  get: "#4ade80",
  post: "#5865f2",
  put: "#fbbf24",
  patch: "#fbbf24",
  delete: "#f87171",
};

interface OperationLike {
  tags?: string[];
  summary?: string;
  security?: Array<Record<string, unknown>>;
}

export function renderDocsPage(spec: Record<string, any>): string {
  const tags: Array<{ name: string; description?: string }> = spec.tags ?? [];
  const paths: Record<string, Record<string, OperationLike>> = spec.paths ?? {};

  // Group operations by their first tag, preserving the declared tag order.
  const byTag = new Map<string, string[]>();
  for (const t of tags) byTag.set(t.name, []);
  const other: string[] = [];

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags?.[0];
      const row = renderRow(method, path, op);
      if (tag && byTag.has(tag)) byTag.get(tag)!.push(row);
      else other.push(row);
    }
  }

  const sections = tags
    .map((t) => {
      const rows = byTag.get(t.name) ?? [];
      if (!rows.length) return "";
      return `<section><h2>${esc(t.name)}</h2>${
        t.description ? `<p class="tagdesc">${esc(t.description)}</p>` : ""
      }<div class="rows">${rows.join("")}</div></section>`;
    })
    .join("");
  const otherSection = other.length
    ? `<section><h2>Other</h2><div class="rows">${other.join("")}</div></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>atelier-api — API reference</title>
<link rel="icon" href="/logo.png" />
<style>
  :root { --bg:#0b0b0b; --panel:rgba(255,255,255,.03); --border:rgba(255,255,255,.1);
    --blurple:#5865f2; --txt:#fff; --txt-2:rgba(255,255,255,.55); --txt-3:rgba(255,255,255,.4); }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--txt); font-family:"Sora","Segoe UI",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased; font-size:14px; line-height:1.5; }
  .wrap { max-width:920px; margin:0 auto; padding:48px 24px 80px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:8px; }
  header img { width:40px; height:40px; }
  header b { font-size:24px; font-weight:600; letter-spacing:-.02em; }
  header .ver { font-size:12px; color:var(--blurple); font-weight:600; background:rgba(88,101,242,.14);
    border:1px solid rgba(88,101,242,.3); border-radius:999px; padding:3px 10px; }
  .lead { color:var(--txt-2); font-size:14px; margin:14px 0 10px; max-width:680px; }
  .lead code { font-family:ui-monospace,Consolas,monospace; background:rgba(255,255,255,.06);
    padding:1px 6px; border-radius:6px; font-size:12.5px; }
  .speclink { display:inline-flex; gap:7px; align-items:center; font-size:13px; color:var(--blurple);
    text-decoration:none; border:1px solid rgba(88,101,242,.3); border-radius:9px; padding:7px 12px; margin-bottom:28px; }
  .speclink:hover { background:rgba(88,101,242,.12); }
  section { margin-top:34px; }
  h2 { font-size:16px; font-weight:600; letter-spacing:-.01em; padding-bottom:8px;
    border-bottom:1px solid var(--border); margin-bottom:4px; }
  .tagdesc { color:var(--txt-3); font-size:12.5px; margin:6px 0 12px; }
  .rows { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
  .row { display:grid; grid-template-columns:64px 1fr; gap:12px; align-items:baseline;
    background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:12px 14px; }
  .m { font-family:ui-monospace,Consolas,monospace; font-size:11px; font-weight:700; text-transform:uppercase;
    text-align:center; padding:3px 0; border-radius:6px; color:#0b0b0b; }
  .path { font-family:ui-monospace,Consolas,monospace; font-size:13px; word-break:break-all; }
  .sum { color:var(--txt-2); font-size:12.5px; margin-top:4px; }
  .lock { color:var(--txt-3); font-size:11px; margin-top:4px; }
  .lock b { color:var(--txt-2); font-weight:600; }
  a { color:var(--blurple); }
  @media (max-width:560px) { .row { grid-template-columns:56px 1fr; } .wrap { padding:32px 16px 60px; } }
</style>
</head>
<body>
<div class="wrap">
  <header><img src="/logo.png" alt="" /><b>atelier-api</b><span class="ver">v${esc(spec.info?.version)}</span></header>
  <p class="lead">${esc(spec.info?.description)}</p>
  <a class="speclink" href="/openapi.json">Download OpenAPI spec (openapi.json) →</a>
  ${sections}${otherSection}
</div>
</body>
</html>`;
}

function renderRow(method: string, path: string, op: OperationLike): string {
  const color = METHOD_COLORS[method] ?? "#888";
  const auth = describeAuth(op.security);
  return `<div class="row">
    <span class="m" style="background:${color}">${esc(method)}</span>
    <div><div class="path">${esc(path)}</div>
      ${op.summary ? `<div class="sum">${esc(op.summary)}</div>` : ""}
      <div class="lock">Auth: <b>${esc(auth)}</b></div></div>
  </div>`;
}

/** Human label for an operation's security requirement. */
function describeAuth(security?: Array<Record<string, unknown>>): string {
  if (!security || security.length === 0) return "none";
  const names = new Set<string>();
  for (const req of security) for (const k of Object.keys(req)) names.add(k);
  const label: Record<string, string> = {
    bearerAuth: "Bearer (device token)",
    serviceToken: "Service token",
    adminCookie: "Admin session",
  };
  return [...names].map((n) => label[n] ?? n).join(" or ");
}
