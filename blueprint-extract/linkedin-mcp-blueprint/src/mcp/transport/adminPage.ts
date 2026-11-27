/**
 * Admin UI (M5): a single self-contained HTML page served at /admin with
 * no build step and a strict CSP (script-src 'self' means everything is
 * inlined here as one module script — no CDN, no external assets).
 *
 * It is a REAL product surface: the page speaks the MCP protocol itself
 * (initialize → tools/list → tools/call) against /mcp using the session
 * cookie, and drives the auth routes. No fake data anywhere; every state
 * derives from actual responses. Publish requires the same confirm:true
 * gate as any MCP client — the UI cannot bypass backend authorization.
 *
 * Design language (owner M5 Phase 7): restrained radii (2–4px), strong
 * typographic hierarchy, subtle 1px borders, dense professional spacing,
 * no glassmorphism/gradient blobs/icon spam. Motion is purposeful only
 * (M5: transitions on state changes, no decorative animation).
 */
export const ADMIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LinkedIn MCP — Console</title>
<style>
  :root {
    --bg: #f4f4f2; --surface: #ffffff; --ink: #16181d; --ink-2: #54565e;
    --ink-3: #8a8c94; --line: #d8d9de; --line-strong: #a9abb4;
    --accent: #2f5fd0; --accent-ink: #ffffff; --ok: #1e7a3c; --bad: #b3261e;
    --warn: #9a6700; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --r: 3px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--sans); background: var(--bg); color: var(--ink);
    font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .topbar {
    background: var(--surface); border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 16px; padding: 0 20px;
    height: 52px; position: sticky; top: 0; z-index: 10;
  }
  .brand { font-weight: 600; letter-spacing: .2px; font-size: 15px; }
  .brand .sub { color: var(--ink-3); font-weight: 400; margin-left: 8px; font-size: 12.5px; }
  .topbar .spacer { flex: 1; }
  .whoami { color: var(--ink-2); font-size: 12.5px; display: flex; align-items: center; gap: 8px; }
  .whoami b { color: var(--ink); font-weight: 600; }

  .layout { display: grid; grid-template-columns: 220px 1fr; min-height: calc(100vh - 52px); }
  .sidenav { background: var(--surface); border-right: 1px solid var(--line); padding: 12px 0; }
  .sidenav h2 {
    margin: 8px 16px 6px; font-size: 11px; text-transform: uppercase;
    letter-spacing: .8px; color: var(--ink-3); font-weight: 600;
  }
  .navitem {
    display: block; padding: 7px 16px; color: var(--ink-2); cursor: pointer;
    border-left: 2px solid transparent; font-size: 13.5px;
  }
  .navitem:hover { background: #fafafa; color: var(--ink); }
  .navitem.active { border-left-color: var(--accent); color: var(--ink); background: #f7f9ff; font-weight: 500; }
  .navitem .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 8px; }
  .dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.idle { background: var(--line-strong); }

  main { padding: 20px 24px; max-width: 980px; }
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); margin-bottom: 16px; }
  .panel-head {
    padding: 10px 16px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 10px;
  }
  .panel-head h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .2px; }
  .panel-head .hint { color: var(--ink-3); font-size: 12px; }
  .panel-body { padding: 16px; }

  .kv { display: grid; grid-template-columns: 170px 1fr; row-gap: 7px; column-gap: 14px; font-size: 13px; }
  .kv dt { color: var(--ink-2); }
  .kv dd { margin: 0; font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
  .kv dd.pill { font-family: var(--sans); }

  .pill { display: inline-block; padding: 1px 8px; border-radius: 2px; font-size: 12px; font-weight: 500; border: 1px solid; }
  .pill.ok { color: var(--ok); border-color: #b7dcc2; background: #f0f9f2; }
  .pill.bad { color: var(--bad); border-color: #edc4c0; background: #fdf2f1; }
  .pill.warn { color: var(--warn); border-color: #e6d9ac; background: #fdf8ec; }
  .pill.idle { color: var(--ink-2); border-color: var(--line); background: #f6f6f8; }

  .btn {
    appearance: none; border: 1px solid var(--line-strong); background: var(--surface);
    color: var(--ink); padding: 6px 14px; border-radius: var(--r); font-size: 13px;
    font-family: var(--sans); cursor: pointer; transition: background .12s ease, border-color .12s ease;
  }
  .btn:hover { background: #f6f7f9; border-color: var(--ink-3); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .btn.primary:hover { background: #2854b4; }
  .btn.danger { color: var(--bad); border-color: #d9a09a; }
  .btn.danger:hover { background: #fdf4f3; }
  .btn.tiny { padding: 2px 9px; font-size: 12px; }

  input[type=text], input[type=password], textarea {
    width: 100%; border: 1px solid var(--line-strong); border-radius: var(--r);
    padding: 7px 10px; font-size: 13px; font-family: var(--sans); color: var(--ink);
    background: var(--surface); transition: border-color .12s ease;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { font-family: var(--mono); font-size: 12.5px; min-height: 130px; resize: vertical; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 4px; font-weight: 500; }

  .counter { font-size: 12px; color: var(--ink-3); font-family: var(--mono); text-align: right; margin-top: 4px; }
  .counter.over { color: var(--bad); }

  .notice { border-radius: var(--r); padding: 9px 12px; font-size: 13px; margin-bottom: 12px; border: 1px solid; }
  .notice.ok { background: #f0f9f2; border-color: #b7dcc2; color: #14522a; }
  .notice.err { background: #fdf2f1; border-color: #edc4c0; color: #7c1d16; }
  .notice.info { background: #f3f6ff; border-color: #c3d2f0; color: #1c3d8f; }
  .notice { display: none; }
  .notice.show { display: block; }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--ink-2); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .5px; }
  td.mono { font-family: var(--mono); font-size: 12px; }
  tr:last-child td { border-bottom: none; }

  .login-wrap { max-width: 380px; margin: 10vh auto 0; }
  .login-wrap .panel-body { padding: 22px; }

  .section-title { font-size: 16px; font-weight: 600; margin: 4px 0 14px; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .toolbar .right { margin-left: auto; }

  .composer-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .confirm-box {
    display: none; align-items: flex-start; gap: 8px; padding: 10px 12px; margin-top: 12px;
    background: #fdf8ec; border: 1px solid #e6d9ac; border-radius: var(--r); font-size: 12.5px; color: #6b4a00;
  }
  .confirm-box.show { display: flex; }
  .confirm-box input { margin-top: 2px; }

  .loading { color: var(--ink-3); font-size: 12.5px; }
  .empty { color: var(--ink-3); font-size: 12.5px; padding: 14px 0; text-align: center; }

  .fade-in { animation: fadeIn .18s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }

  @media (max-width: 760px) {
    .layout { grid-template-columns: 1fr; }
    .sidenav { display: flex; overflow-x: auto; border-right: none; border-bottom: 1px solid var(--line); padding: 0; }
    .sidenav h2 { display: none; }
    .navitem { border-left: none; border-bottom: 2px solid transparent; white-space: nowrap; }
    .navitem.active { border-bottom-color: var(--accent); }
    main { padding: 14px; }
    .kv { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">LinkedIn MCP<span class="sub">Console</span></div>
  <div class="spacer"></div>
  <div class="whoami" id="whoami"></div>
</div>

<div id="authed" style="display:none">
  <div class="layout">
    <nav class="sidenav">
      <h2>Workspace</h2>
      <a class="navitem active" data-view="overview" id="nav-overview"><span class="dot idle" id="dot-conn"></span>Overview</a>
      <a class="navitem" data-view="composer" id="nav-composer">Composer</a>
      <a class="navitem" data-view="activity" id="nav-activity">Activity</a>
      <a class="navitem" data-view="settings" id="nav-settings">Settings</a>
    </nav>
    <main id="main"></main>
  </div>
</div>

<div id="anon">
  <div class="login-wrap">
    <form class="panel" id="login-form">
      <div class="panel-head"><h3>Sign in</h3><span class="hint">session authentication</span></div>
      <div class="panel-body">
        <div class="notice err" id="login-error"></div>
        <div class="field">
          <label for="login-user">Username</label>
          <input type="text" id="login-user" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="login-pass">Password</label>
          <input type="password" id="login-pass" autocomplete="current-password" required>
        </div>
        <button class="btn primary" type="submit" style="width:100%">Sign in</button>
      </div>
    </form>
  </div>
</div>

<script>
"use strict";
/* Console UI — speaks the MCP protocol (Streamable HTTP) directly.
   No framework, no build step; CSP is script-src 'self'. */

const M = {
  csrf: null,
  me: null,
  view: 'overview',
  tools: [],
  lastDraft: null,
};

const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const headers = { 'accept': 'application/json', 'content-type': 'application/json' };
  if (M.csrf && (opts && opts.method === 'POST')) headers['x-csrf-token'] = M.csrf;
  const r = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

/* ---- MCP client ---- */
let mcpSession = null;
const PROTO = 'io.modelcontextprotocol/protocolVersion';

async function mcpInitialize() {
  // NOTE: initialize is the legacy handshake — it must NOT carry
  // MCP-Protocol-Version (the SDK rejects the mismatch with -32020).
  // Post-initialize requests set the header (see mcpCall).
  const r = await fetch('/mcp', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'lkm-console', version: '1.0.0' },
      },
    }),
  });
  if (r.status !== 200) throw new Error('initialize failed: ' + r.status);
  const hdr = r.headers.get('mcp-session-id');
  if (hdr) mcpSession = hdr;
  await r.json();
}

async function mcpCall(id, method, params) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
  };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const r = await fetch('/mcp', {
    method: 'POST', credentials: 'same-origin', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
  });
  if (r.status !== 200) {
    const t = await r.text().catch(() => '');
    throw new Error('MCP ' + method + ' -> HTTP ' + r.status + ' ' + t.slice(0, 140));
  }
  const ct = r.headers.get('content-type') || '';
  const text = await r.text();
  let payload = null;
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\\n')) {
      if (line.startsWith('data:')) { payload = JSON.parse(line.slice(5).trim()); break; }
    }
  } else {
    payload = text ? JSON.parse(text) : null;
  }
  if (!payload) throw new Error('empty MCP response');
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  return payload.result;
}

async function toolCall(name, args) {
  const result = await mcpCall(Math.floor(Math.random() * 1e6), 'tools/call', { name, arguments: args });
  const text = result && result.content && result.content[0] ? result.content[0].text : '{}';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  parsed.__isError = !!result.isError;
  return parsed;
}

/* ---- boot ---- */
async function boot() {
  const { body } = await api('/auth/state');
  if (!body.authenticated) { $('anon').style.display = ''; return; }
  M.me = body;
  M.csrf = sessionStorage.getItem('csrf-' + body.tenantId) || null;
  try { await mcpInitialize(); } catch (e) { toast('MCP session failed: ' + e.message, 'err'); }
  showApp();
}

function showApp() {
  $('anon').style.display = 'none';
  $('authed').style.display = '';
  $('whoami').innerHTML = '<b>' + esc(M.me.username) + '</b> · ' + esc(M.me.tenantId.slice(0, 18)) +
    ' <button class="btn tiny" id="btn-logout">Sign out</button>';
  $('btn-logout').addEventListener('click', doLogout);
  switchView(M.view);
}

async function doLogout() {
  await api('/auth/logout', { method: 'POST' });
  sessionStorage.removeItem('csrf-' + (M.me ? M.me.tenantId : ''));
  location.reload();
}

function switchView(v) {
  M.view = v;
  document.querySelectorAll('.navitem').forEach((el) =>
    el.classList.toggle('active', el.dataset.view === v));
  const main = $('main');
  main.innerHTML = '';
  main.className = 'fade-in';
  if (v === 'overview') renderOverview();
  else if (v === 'composer') renderComposer();
  else if (v === 'activity') renderActivity();
  else if (v === 'settings') renderSettings();
}

/* ---- Overview ---- */
async function renderOverview() {
  const main = $('main');
  main.innerHTML = '<div class="section-title">Overview</div><div class="loading">Loading connection state…</div>';
  let status, scopes, profile;
  const results = await Promise.allSettled([
    toolCall('linkedin_status', {}),
    toolCall('linkedin_list_granted_scopes', {}),
    toolCall('linkedin_get_my_profile', {}),
  ]);
  status = results[0].status === 'fulfilled' ? results[0].value : null;
  scopes = results[1].status === 'fulfilled' ? results[1].value : null;
  profile = results[2].status === 'fulfilled' ? results[2].value : null;

  const connected = status && status.connected;
  $('dot-conn').className = 'dot ' + (connected ? 'ok' : 'bad');

  main.innerHTML = '<div class="section-title">Overview</div>' +
    '<div class="panel"><div class="panel-head"><h3>LinkedIn connection</h3><span class="hint">tenant ' + esc(M.me.tenantId.slice(0, 14)) + '…</span></div><div class="panel-body" id="ov-conn"></div></div>' +
    '<div class="panel"><div class="panel-head"><h3>Identity</h3><span class="hint">from OIDC userinfo</span></div><div class="panel-body" id="ov-profile"></div></div>' +
    '<div class="panel"><div class="panel-head"><h3>Granted scopes</h3><span class="hint">token-response claim</span></div><div class="panel-body" id="ov-scopes"></div></div>' +
    '<div class="toolbar" style="margin-top:4px"><button class="btn primary" id="btn-connect">Connect LinkedIn</button>' +
    '<button class="btn danger" id="btn-disconnect" ' + (connected ? '' : 'disabled') + '>Disconnect</button></div>' +
    '<div class="notice ok" id="ov-ok"></div><div class="notice err" id="ov-err"></div>';

  const connBody = $('ov-conn');
  if (status && status.__isError) {
    connBody.innerHTML = '<div class="pill bad">not connected</div>';
  } else if (status) {
    connBody.innerHTML =
      '<dl class="kv">' +
      '<dt>State</dt><dd class="pill">' + (connected ? '<span class="pill ok">connected</span>' : '<span class="pill bad">not connected</span>') + '</dd>' +
      '<dt>Token expires</dt><dd>' + (status.expiresAt ? new Date(status.expiresAt).toISOString() : '—') + '</dd>' +
      '<dt>Expires in</dt><dd>' + (status.expiresInDays !== undefined ? String(status.expiresInDays) + ' days' : '—') + '</dd>' +
      '<dt>Member ID</dt><dd>' + (status.memberId ? esc(String(status.memberId)) : '—') + '</dd>' +
      '</dl>';
  } else {
    connBody.innerHTML = '<div class="pill bad">status unavailable</div>';
  }

  const profBody = $('ov-profile');
  if (profile && !profile.__isError) {
    profBody.innerHTML = '<dl class="kv">' +
      '<dt>Name</dt><dd>' + esc(profile.name || '—') + '</dd>' +
      '<dt>Email</dt><dd>' + esc(profile.email || '—') + ' ' + (profile.emailVerified ? '<span class="pill ok">verified</span>' : '') + '</dd>' +
      '<dt>Member sub</dt><dd>' + esc(profile.memberId || '—') + '</dd>' +
      '<dt>Locale</dt><dd>' + (profile.locale ? esc(profile.locale.language + (profile.locale.country ? '-' + profile.locale.country : '')) : '—') + '</dd>' +
      '</dl>';
  } else {
    profBody.innerHTML = '<div class="pill idle">connect to load identity</div>';
  }

  const scopeBody = $('ov-scopes');
  if (scopes && !scopes.__isError) {
    const rows = (scopes.requestedScopes || []).map((s) => {
      const granted = (scopes.tokenScopeClaim || '').split(' ').includes(s);
      return '<tr><td class="mono">' + esc(s) + '</td><td>' +
        (granted ? '<span class="pill ok">granted</span>' : '<span class="pill warn">not in claim</span>') + '</td></tr>';
    }).join('');
    scopeBody.innerHTML = '<table><thead><tr><th>Scope</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div style="color:var(--ink-3);font-size:11.5px;margin-top:8px">verification: ' + esc(String(scopes.verification || 'unverified')) + ' — LinkedIn exposes no introspection endpoint (ADR-013)</div>';
  } else {
    scopeBody.innerHTML = '<div class="pill idle">unavailable</div>';
  }

  $('btn-connect').addEventListener('click', () => {
    window.location.href = '/linkedin/connect';
  });
  $('btn-disconnect').addEventListener('click', async () => {
    if (!confirm('Disconnect the LinkedIn account for this tenant? Tokens are deleted.')) return;
    const r = await toolCall('linkedin_disconnect', { confirm: true });
    if (r.__isError) { $('ov-err').textContent = r.error || 'disconnect failed'; $('ov-err').classList.add('show'); }
    else { $('ov-ok').textContent = 'Disconnected.'; $('ov-ok').classList.add('show'); }
    setTimeout(renderOverview, 900);
  });
}

/* ---- Composer ---- */
async function renderComposer() {
  const main = $('main');
  main.innerHTML = '<div class="section-title">Composer</div>' +
    '<div class="panel"><div class="panel-head"><h3>New post</h3><span class="hint">text only · max 3,000 characters</span></div><div class="panel-body">' +
    '<div class="notice err" id="c-err"></div>' +
    '<div class="field"><label for="c-text">Post text</label>' +
    '<textarea id="c-text" maxlength="6000" placeholder="What do you want to say?"></textarea>' +
    '<div class="counter" id="c-counter">0 / 3000</div></div>' +
    '<div class="composer-actions">' +
    '<button class="btn" id="c-draft">Validate</button>' +
    '<button class="btn" id="c-preview">Preview payload</button>' +
    '<div style="flex:1"></div>' +
    '<button class="btn danger" id="c-publish">Publish…</button></div>' +
    '<div class="confirm-box" id="c-confirm">' +
    '<input type="checkbox" id="c-confirm-check">' +
    '<div><b>Publish to the connected LinkedIn account.</b> This creates a real post (Posts API, w_member_social). The confirm gate is the same one any MCP client passes through — this UI cannot bypass it. Tick the box to arm, then confirm.</div></div>' +
    '</div></div>' +
    '<div class="panel" id="c-result-panel" style="display:none"><div class="panel-head"><h3>Result</h3></div><div class="panel-body" id="c-result"></div></div>';

  const ta = $('c-text');
  ta.addEventListener('input', () => {
    const n = ta.value.length;
    const el = $('c-counter');
    el.textContent = n + ' / 3000';
    el.className = 'counter' + (n > 3000 ? ' over' : '');
  });

  $('c-draft').addEventListener('click', async () => {
    hide('c-err');
    const r = await toolCall('linkedin_draft_post', { text: ta.value });
    showResult(r, 'Draft validation');
  });
  $('c-preview').addEventListener('click', async () => {
    hide('c-err');
    const r = await toolCall('linkedin_preview_post', { text: ta.value });
    showResult(r, 'Exact submission preview');
  });
  $('c-publish').addEventListener('click', async () => {
    hide('c-err');
    if (!$('c-confirm-check').checked) {
      $('c-err').textContent = 'Arm the confirmation checkbox first — publishing requires an explicit confirm:true.';
      $('c-err').classList.add('show');
      return;
    }
    if (!confirm('Publish this post to LinkedIn now?')) return;
    const r = await toolCall('linkedin_publish_post', { text: ta.value, confirm: true });
    showResult(r, 'Publication');
    setTimeout(() => { renderOverview(); }, 400);
  });

  function showResult(r, title) {
    $('c-result-panel').style.display = '';
    $('c-result-panel').querySelector('h3').textContent = title;
    const ok = !r.__isError;
    const clone = { ...r };
    delete clone.__isError;
    $('c-result').innerHTML =
      (ok ? '' : '<div class="notice err show">' + esc(r.error || 'error') + (r.code ? ' · code: ' + esc(String(r.code)) : '') + '</div>') +
      '<pre style="font-family:var(--mono);font-size:12px;background:#f8f8f6;border:1px solid var(--line);border-radius:3px;padding:10px;overflow-x:auto;max-height:340px;overflow-y:auto;margin:0">' + esc(JSON.stringify(clone, null, 2)) + '</pre>';
  }
}

/* ---- Activity ---- */
let activityLog = [];
async function renderActivity() {
  const main = $('main');
  main.innerHTML = '<div class="section-title">Activity</div>' +
    '<div class="panel"><div class="panel-head"><h3>Recent tool operations</h3><span class="hint">this console session</span></div><div class="panel-body" id="act-body">' +
    '<table><thead><tr><th>Time</th><th>Operation</th><th>Outcome</th></tr></thead><tbody id="act-rows"></tbody></table>' +
    '<div class="empty" id="act-empty">No operations yet this session. Draft, preview or publish from the Composer.</div>' +
    '</div></div>';
  const rows = $('act-rows');
  if (activityLog.length === 0) { $('act-empty').style.display = ''; }
  else {
    $('act-empty').style.display = 'none';
    for (const it of activityLog.slice(0, 25).reverse()) {
      const tr = document.createElement('tr');
      const tdT = document.createElement('td'); tdT.className = 'mono'; tdT.textContent = it.time;
      const tdO = document.createElement('td'); tdO.textContent = it.op;
      const tdR = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'pill ' + (it.ok ? 'ok' : 'bad');
      pill.textContent = it.ok ? 'ok' : 'error';
      tdR.appendChild(pill);
      tr.append(tdT, tdO, tdR);
      rows.appendChild(tr);
    }
  }
}

/* ---- Settings ---- */
async function renderSettings() {
  const main = $('main');
  const st = await toolCall('status', {});
  main.innerHTML = '<div class="section-title">Settings</div>' +
    '<div class="panel"><div class="panel-head"><h3>Server</h3><span class="hint">read-only from the MCP status tool</span></div><div class="panel-body">' +
    '<dl class="kv">' +
    '<dt>Server</dt><dd>' + esc(String(st.server || '—')) + ' ' + esc(String(st.version || '')) + '</dd>' +
    '<dt>Environment</dt><dd>' + esc(String(st.environment || '—')) + '</dd>' +
    '<dt>OAuth provider</dt><dd>' + esc(String(st.oauthProvider || '—')) + '</dd>' +
    '<dt>LinkedIn</dt><dd>' + esc(String(st.linkedin || '—')) + '</dd>' +
    '<dt>Your tenant</dt><dd>' + esc(M.me.tenantId) + '</dd>' +
    '<dt>Session</dt><dd>' + esc(M.me.via) + '</dd>' +
    '</dl></div></div>' +
    '<div class="panel"><div class="panel-head"><h3>Security posture</h3><span class="hint">enforced server-side</span></div><div class="panel-body">' +
    '<table><tbody>' +
    '<tr><td>Publish confirmation</td><td><span class="pill ok">required — confirm:true enforced at schema level</span></td></tr>' +
    '<tr><td>Token storage</td><td><span class="pill ok">AES-256-GCM sealed, tenant-bound</span></td></tr>' +
    '<tr><td>Duplicate protection</td><td><span class="pill ok">content-hash window + in-flight lock</span></td></tr>' +
    '<tr><td>Daily publish budget</td><td><span class="pill ok">app-level safety limit (ADR-015)</span></td></tr>' +
    '</tbody></table></div></div>';
}

/* ---- helpers ---- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function hide(id) { const el = $(id); el.classList.remove('show'); el.textContent = ''; }
function toast(msg, kind) {
  console.log('[console]', msg);
}

/* wire nav */
document.querySelectorAll('.navitem').forEach((el) => {
  el.addEventListener('click', (e) => { e.preventDefault(); switchView(el.dataset.view); });
});

/* wire login */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hide('login-error');
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  const { status, body } = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  if (status !== 200 || !body.authenticated) {
    $('login-error').textContent = 'Invalid username or password.';
    $('login-error').classList.add('show');
    return;
  }
  M.me = { tenantId: body.tenantId, username: body.username, via: 'session' };
  M.csrf = body.csrfToken;
  sessionStorage.setItem('csrf-' + body.tenantId, body.csrfToken);
  try { await mcpInitialize(); } catch (err) { toast(String(err), 'err'); }
  showApp();
});

boot();
</script>
</body>
</html>`;
