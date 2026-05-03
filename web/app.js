// Tap Check — vanilla PWA
// Single-file app. Hash routing: #/ , #/c/:id , #/import , #/settings

const STORAGE = {
  checklists: 'tapcheck.checklists',  // [{id,title,created_at,sections}]
  doneFor: (id) => `tapcheck.done.${id}`, // {"s.i": true}
  expandFor: (id) => `tapcheck.expand.${id}`, // {"s": bool}
  archived: 'tapcheck.archived',      // [id]
  config: 'tapcheck.config',          // {workerUrl, secret}
  lastSync: 'tapcheck.lastSync',      // iso
};

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
};

// ---------- Storage helpers ----------
const load = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
};
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const getChecklists = () => load(STORAGE.checklists, []);
const setChecklists = (list) => save(STORAGE.checklists, list);
const getArchived = () => new Set(load(STORAGE.archived, []));
const setArchived = (set) => save(STORAGE.archived, [...set]);
const getConfig = () => load(STORAGE.config, { workerUrl: '', secret: '' });
const setConfig = (c) => save(STORAGE.config, c);

const upsertChecklist = (cl) => {
  const list = getChecklists();
  const idx = list.findIndex((x) => x.id === cl.id);
  if (idx >= 0) list[idx] = cl;
  else list.unshift(cl);
  setChecklists(list);
};

const removeChecklist = (id) => {
  setChecklists(getChecklists().filter((c) => c.id !== id));
  localStorage.removeItem(STORAGE.doneFor(id));
  localStorage.removeItem(STORAGE.expandFor(id));
};

// ---------- Validation ----------
function validateChecklist(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not an object.');
  if (typeof obj.title !== 'string' || !obj.title.trim()) throw new Error('Missing title.');
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) throw new Error('Missing sections.');
  for (const [si, s] of obj.sections.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`Section ${si} not an object.`);
    if (typeof s.label !== 'string') throw new Error(`Section ${si} missing label.`);
    if (!Array.isArray(s.items)) throw new Error(`Section ${si} missing items.`);
    for (const [ii, it] of s.items.entries()) {
      if (!it || typeof it !== 'object') throw new Error(`Item ${si}.${ii} not an object.`);
      if (typeof it.text !== 'string' || !it.text.trim()) throw new Error(`Item ${si}.${ii} missing text.`);
    }
  }
  return {
    id: obj.id || crypto.randomUUID(),
    title: obj.title.trim(),
    created_at: obj.created_at || new Date().toISOString(),
    sections: obj.sections.map((s) => ({
      label: s.label,
      items: s.items.map((it) => ({
        text: it.text,
        detail: it.detail || null,
      })),
    })),
  };
}

// ---------- Server sync ----------
async function api(path, opts = {}) {
  const cfg = getConfig();
  if (!cfg.workerUrl) throw new Error('Worker URL not configured.');
  const url = cfg.workerUrl.replace(/\/$/, '') + path;
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (cfg.secret) headers.authorization = `Bearer ${cfg.secret}`;
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json();
}

async function syncFromServer() {
  const cfg = getConfig();
  if (!cfg.workerUrl) return { ok: false, reason: 'not-configured' };
  try {
    const list = await api('/checklists');
    let added = 0;
    const have = new Set(getChecklists().map((c) => c.id));
    for (const meta of list) {
      if (have.has(meta.id)) continue;
      const full = await api(`/checklists/${meta.id}`);
      upsertChecklist(validateChecklist(full));
      added++;
    }
    save(STORAGE.lastSync, new Date().toISOString());
    return { ok: true, added };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------- Done / progress ----------
const getDone = (id) => load(STORAGE.doneFor(id), {});
const setDone = (id, d) => save(STORAGE.doneFor(id), d);
const itemKey = (s, i) => `${s}.${i}`;

function checklistProgress(cl) {
  const done = getDone(cl.id);
  let total = 0, complete = 0;
  cl.sections.forEach((s, si) => {
    s.items.forEach((_, ii) => {
      total++;
      if (done[itemKey(si, ii)]) complete++;
    });
  });
  return { total, complete };
}
function sectionProgress(cl, si) {
  const done = getDone(cl.id);
  const items = cl.sections[si].items;
  let complete = 0;
  items.forEach((_, ii) => { if (done[itemKey(si, ii)]) complete++; });
  return { total: items.length, complete };
}

// ---------- Routing ----------
function route() {
  const hash = location.hash.slice(1) || '/';
  if (hash === '/' || hash === '') return renderHome();
  if (hash === '/import') return renderImport();
  if (hash === '/settings') return renderSettings();
  const m = hash.match(/^\/c\/([^/]+)$/);
  if (m) return renderChecklist(m[1]);
  renderHome();
}

window.addEventListener('hashchange', route);

// ---------- Home ----------
function fmtRel(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderHome() {
  const archived = getArchived();
  const lists = getChecklists()
    .filter((c) => !archived.has(c.id))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const app = $('#app');
  app.replaceChildren();

  app.appendChild(h('div', { class: 'home-header' },
    h('h1', {}, 'Tap Check'),
    h('div', { class: 'sub' }, lists.length ? `${lists.length} active` : '')
  ));

  if (lists.length === 0) {
    app.appendChild(h('div', { class: 'card empty' },
      h('p', {}, 'No checklists yet.'),
      h('p', {}, h('a', { href: '#/import' }, 'Paste JSON'),
        ' or push one from Claude.')
    ));
  } else {
    const wrap = h('div', { class: 'cl-list' });
    for (const cl of lists) wrap.appendChild(homeRow(cl));
    app.appendChild(wrap);
  }

  app.appendChild(h('div', { class: 'fab-row' },
    h('button', { class: 'fab secondary', onclick: refreshNow }, 'Refresh'),
    h('a', { class: 'fab', href: '#/import' }, '+ Import'),
  ));
}

function homeRow(cl) {
  const { complete, total } = checklistProgress(cl);
  const pct = total ? Math.round((complete / total) * 100) : 0;

  const fg = h('div', { class: 'swipe-fg' },
    h('div', { class: 'row-title' }, cl.title),
    h('div', { class: 'row-meta' },
      h('span', {}, `${complete}/${total}`),
      h('div', { class: 'mini-bar' }, h('span', { style: `width:${pct}%` })),
      h('span', {}, fmtRel(cl.created_at)),
    )
  );

  const row = h('div', { class: 'cl-row' },
    h('div', { class: 'swipe-bg' }, 'Archive'),
    fg,
  );

  // Tap to open
  let dragging = false, startX = 0, dx = 0, swiped = false;
  fg.addEventListener('pointerdown', (e) => {
    dragging = true; startX = e.clientX; dx = 0;
    fg.setPointerCapture(e.pointerId);
  });
  fg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = Math.min(0, e.clientX - startX);
    fg.style.transform = `translateX(${dx}px)`;
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    if (dx < -80) {
      fg.style.transform = `translateX(-100%)`;
      swiped = true;
      setTimeout(() => archive(cl.id), 180);
    } else {
      fg.style.transform = '';
      if (Math.abs(dx) < 6 && !swiped) location.hash = `#/c/${cl.id}`;
    }
  };
  fg.addEventListener('pointerup', finish);
  fg.addEventListener('pointercancel', finish);

  return row;
}

function archive(id) {
  const a = getArchived();
  a.add(id);
  setArchived(a);
  // Also delete on server (best-effort)
  api(`/checklists/${id}`, { method: 'DELETE' }).catch(() => {});
  removeChecklist(id);
  toast('Archived');
  renderHome();
}

async function refreshNow() {
  toast('Syncing…');
  const r = await syncFromServer();
  if (!r.ok) {
    toast(r.reason === 'not-configured' ? 'Set worker URL in settings' : `Sync failed: ${r.reason}`);
    if (r.reason === 'not-configured') location.hash = '#/settings';
    return;
  }
  toast(r.added ? `+${r.added} new` : 'Up to date');
  renderHome();
}

// ---------- Checklist ----------
function renderChecklist(id) {
  const cl = getChecklists().find((c) => c.id === id);
  const app = $('#app');
  app.replaceChildren();

  app.appendChild(h('div', { class: 'topbar' },
    h('a', { class: 'back', href: '#/', 'aria-label': 'Back' }, '‹'),
    h('div', { class: 'spacer' }),
  ));

  if (!cl) {
    app.appendChild(h('div', { class: 'card empty' }, h('p', {}, 'Checklist not found.')));
    return;
  }

  const card = h('div', { class: 'card' });
  app.appendChild(card);

  const progress = checklistProgress(cl);
  const pct = progress.total ? Math.round((progress.complete / progress.total) * 100) : 0;
  card.appendChild(h('div', { class: 'cl-header' },
    h('div', { class: 'cl-eyebrow' },
      h('span', {}, 'ACTIVE CHECKLIST'),
      h('span', { class: 'progress-text' }, `${progress.complete}/${progress.total} done`),
    ),
    h('div', { class: 'cl-title' }, cl.title),
    h('div', { class: 'cl-bar' }, h('span', { style: `width:${pct}%` })),
  ));

  const expand = load(STORAGE.expandFor(id), null);
  // Determine which section is active = first with unchecked items
  let activeSi = -1;
  for (let i = 0; i < cl.sections.length; i++) {
    const sp = sectionProgress(cl, i);
    if (sp.complete < sp.total) { activeSi = i; break; }
  }

  cl.sections.forEach((sec, si) => {
    const sp = sectionProgress(cl, si);
    const state = sp.complete === sp.total ? 'done' : sp.complete === 0 ? 'idle' : 'progress';
    const userOpen = expand && si in expand ? !!expand[si] : (si === activeSi);
    const open = userOpen;

    const secEl = h('section', { class: `section state-${state}${open ? ' open' : ''}`, 'data-si': si });
    const header = h('button', { class: 'section-header', onclick: () => toggleSection(id, si) },
      h('span', { class: 'chev' }, '›'),
      h('span', { class: 'label' }, sec.label),
      h('span', { class: 'count' }, `${sp.complete}/${sp.total}`),
    );
    secEl.appendChild(header);

    const body = h('div', { class: 'section-body' });
    const done = getDone(id);

    // First unchecked item index in this section
    let firstUnchecked = -1;
    if (si === activeSi) {
      for (let ii = 0; ii < sec.items.length; ii++) {
        if (!done[itemKey(si, ii)]) { firstUnchecked = ii; break; }
      }
    }

    sec.items.forEach((it, ii) => {
      const isDone = !!done[itemKey(si, ii)];
      const highlight = ii === firstUnchecked;
      const itemEl = h('button', {
        class: `item${isDone ? ' done' : ''}${highlight ? ' highlight' : ''}`,
        onclick: () => toggleItem(id, si, ii),
      },
        h('span', { class: 'box' }, h('span', { html: CHECK_SVG })),
        h('span', { class: 'body' },
          h('div', { class: 'text' }, it.text),
          it.detail ? h('div', { class: 'detail' }, it.detail) : null,
        ),
      );
      body.appendChild(itemEl);
    });

    secEl.appendChild(body);
    card.appendChild(secEl);
  });
}

function toggleSection(id, si) {
  const expand = load(STORAGE.expandFor(id), {});
  const sec = document.querySelector(`section[data-si="${si}"]`);
  const isOpen = sec.classList.contains('open');
  expand[si] = !isOpen;
  save(STORAGE.expandFor(id), expand);
  sec.classList.toggle('open');
}

function toggleItem(id, si, ii) {
  const done = getDone(id);
  const k = itemKey(si, ii);
  if (done[k]) delete done[k]; else done[k] = true;
  setDone(id, done);
  // Re-render the checklist (cheap; preserves section open state via storage)
  renderChecklist(id);
}

const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 7"></polyline></svg>`;

// ---------- Import ----------
function renderImport() {
  const app = $('#app');
  app.replaceChildren();
  app.appendChild(h('div', { class: 'topbar' },
    h('a', { class: 'back', href: '#/', 'aria-label': 'Back' }, '‹'),
    h('div', { class: 'spacer' }),
    h('a', { class: 'action', href: '#/settings' }, 'Settings'),
  ));

  const ta = h('textarea', { placeholder: '{ "title": "...", "sections": [ ... ] }' });
  const err = h('div', { class: 'err' });

  const submit = () => {
    err.textContent = '';
    let parsed;
    try { parsed = JSON.parse(ta.value); }
    catch (e) { err.textContent = 'Invalid JSON: ' + e.message; return; }
    let cl;
    try { cl = validateChecklist(parsed); }
    catch (e) { err.textContent = e.message; return; }
    upsertChecklist(cl);
    toast('Imported');
    location.hash = `#/c/${cl.id}`;
  };

  app.appendChild(h('div', { class: 'card form' },
    h('h2', {}, 'Paste JSON'),
    h('label', {}, 'Checklist JSON'),
    ta,
    err,
    h('div', { class: 'hint' }, 'Stored locally only. To sync from Claude, configure the worker in settings.'),
    h('div', { class: 'row' },
      h('a', { class: 'fab secondary', href: '#/' }, 'Cancel'),
      h('button', { class: 'fab', onclick: submit }, 'Import'),
    ),
  ));
}

// ---------- Settings ----------
function renderSettings() {
  const app = $('#app');
  app.replaceChildren();
  app.appendChild(h('div', { class: 'topbar' },
    h('a', { class: 'back', href: '#/', 'aria-label': 'Back' }, '‹'),
    h('div', { class: 'spacer' }),
  ));

  const cfg = getConfig();
  const url = h('input', { type: 'url', placeholder: 'https://tap-check.your-subdomain.workers.dev', value: cfg.workerUrl });
  const sec = h('input', { type: 'password', placeholder: 'Optional shared secret', value: cfg.secret });
  const err = h('div', { class: 'err' });

  const test = async () => {
    err.textContent = 'Testing…';
    setConfig({ workerUrl: url.value.trim(), secret: sec.value });
    try {
      await api('/checklists');
      err.textContent = 'OK — connected.';
    } catch (e) { err.textContent = 'Failed: ' + e.message; }
  };
  const saveBtn = () => {
    setConfig({ workerUrl: url.value.trim(), secret: sec.value });
    toast('Saved');
    location.hash = '#/';
  };

  app.appendChild(h('div', { class: 'card form' },
    h('h2', {}, 'Worker'),
    h('label', {}, 'Worker URL'),
    url,
    h('label', {}, 'Shared secret (optional)'),
    sec,
    h('div', { class: 'hint' }, 'Required if your worker has MCP_SECRET set.'),
    err,
    h('div', { class: 'row' },
      h('button', { class: 'fab secondary', onclick: test }, 'Test'),
      h('button', { class: 'fab', onclick: saveBtn }, 'Save'),
    ),
  ));
}

// ---------- Toast ----------
let toastEl;
function toast(msg) {
  if (!toastEl) { toastEl = h('div', { class: 'toast' }); document.body.appendChild(toastEl); }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// ---------- Boot ----------
route();

// Background sync on focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncFromServer().then((r) => { if (r.ok && r.added) route(); });
  }
});

// SW registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

// Initial sync if configured
if (getConfig().workerUrl) {
  syncFromServer().then((r) => { if (r.ok && r.added) route(); });
}
