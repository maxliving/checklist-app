// Tap Check — Cloudflare Worker
// REST endpoints for the PWA + MCP endpoint for Claude.
//
// Bindings (wrangler.toml):
//   - KV namespace CHECKLISTS
//   - Optional secret MCP_SECRET (if set, all endpoints require Authorization: Bearer <secret>)
//   - Var PUBLIC_BASE_URL (used to build returned checklist URLs)

const JSON_HEADERS = { 'content-type': 'application/json' };

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,mcp-session-id',
  'access-control-max-age': '86400',
};

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS, ...(init.headers || {}) },
  });

const text = (body, status = 200) =>
  new Response(body, { status, headers: { ...CORS_HEADERS, 'content-type': 'text/plain' } });

const errJson = (status, message) => json({ error: message }, { status });

function checkAuth(request, env) {
  if (!env.MCP_SECRET) return true;
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && m[1] === env.MCP_SECRET;
}

function publicUrl(env, id) {
  const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}/#/c/${id}` : `#/c/${id}`;
}

// ---------- Validation ----------
function validateChecklist(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Not an object.');
  if (typeof obj.title !== 'string' || !obj.title.trim()) throw new Error('Missing title.');
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) throw new Error('Missing sections.');
  for (const [si, s] of obj.sections.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`Section ${si} not an object.`);
    if (typeof s.label !== 'string') throw new Error(`Section ${si} missing label.`);
    if (!Array.isArray(s.items) || s.items.length === 0) throw new Error(`Section ${si} has no items.`);
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
      items: s.items.map((it) => ({ text: it.text, detail: it.detail ?? null })),
    })),
  };
}

// ---------- KV helpers ----------
const KEY = (id) => `cl:${id}`;
const INDEX_KEY = 'cl:index';

async function readIndex(env) {
  const raw = await env.CHECKLISTS.get(INDEX_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function writeIndex(env, list) {
  await env.CHECKLISTS.put(INDEX_KEY, JSON.stringify(list));
}

async function putChecklist(env, cl) {
  await env.CHECKLISTS.put(KEY(cl.id), JSON.stringify(cl));
  const index = await readIndex(env);
  const trimmed = index.filter((m) => m.id !== cl.id);
  trimmed.unshift({ id: cl.id, title: cl.title, created_at: cl.created_at });
  await writeIndex(env, trimmed);
}

async function deleteChecklist(env, id) {
  await env.CHECKLISTS.delete(KEY(id));
  const index = await readIndex(env);
  const next = index.filter((m) => m.id !== id);
  if (next.length !== index.length) await writeIndex(env, next);
  return next.length !== index.length;
}

async function getChecklist(env, id) {
  const raw = await env.CHECKLISTS.get(KEY(id));
  return raw ? JSON.parse(raw) : null;
}

// ---------- REST router ----------
async function handleRest(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (!checkAuth(request, env)) return errJson(401, 'Unauthorized');

  const path = url.pathname.replace(/\/$/, '') || '/';

  if (path === '/checklists' && request.method === 'GET') {
    const index = await readIndex(env);
    return json(index);
  }
  if (path === '/checklists' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return errJson(400, 'Invalid JSON'); }
    let cl;
    try { cl = validateChecklist(body); } catch (e) { return errJson(400, e.message); }
    await putChecklist(env, cl);
    return json({ id: cl.id, url: publicUrl(env, cl.id) }, { status: 201 });
  }
  const m = path.match(/^\/checklists\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (request.method === 'GET') {
      const cl = await getChecklist(env, id);
      return cl ? json(cl) : errJson(404, 'Not found');
    }
    if (request.method === 'DELETE') {
      const ok = await deleteChecklist(env, id);
      return ok ? new Response(null, { status: 204, headers: CORS_HEADERS }) : errJson(404, 'Not found');
    }
  }
  return errJson(404, 'Not found');
}

// ---------- MCP (JSON-RPC over HTTP) ----------
const MCP_TOOLS = [
  {
    name: 'push_checklist',
    description: 'Store a checklist so it appears in the Tap Check PWA. Returns the id and a URL to open it.',
    inputSchema: {
      type: 'object',
      required: ['checklist'],
      properties: {
        checklist: {
          type: 'object',
          required: ['title', 'sections'],
          properties: {
            id: { type: 'string', description: 'Optional. UUID; generated if omitted.' },
            title: { type: 'string' },
            created_at: { type: 'string', description: 'Optional ISO 8601 timestamp.' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                required: ['label', 'items'],
                properties: {
                  label: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['text'],
                      properties: {
                        text: { type: 'string' },
                        detail: { type: ['string', 'null'], description: 'Optional sets/reps/quantity.' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'list_checklists',
    description: 'List stored checklists (id, title, created_at).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_checklist',
    description: 'Delete a checklist by id.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
];

const SERVER_INFO = { name: 'tap-check', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';

async function callTool(name, args, env) {
  if (name === 'push_checklist') {
    const cl = validateChecklist(args.checklist);
    await putChecklist(env, cl);
    return { id: cl.id, url: publicUrl(env, cl.id) };
  }
  if (name === 'list_checklists') {
    return await readIndex(env);
  }
  if (name === 'delete_checklist') {
    if (!args.id || typeof args.id !== 'string') throw new Error('id is required');
    const ok = await deleteChecklist(env, args.id);
    return { ok };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMcpMessage(msg, env) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    }
    if (method === 'notifications/initialized') return null; // no response for notifications
    if (method === 'tools/list') {
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {}, env);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return rpcError(id, -32000, e.message || String(e));
  }
}

async function handleMcp(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (!checkAuth(request, env)) return errJson(401, 'Unauthorized');

  if (request.method === 'GET') {
    // Streamable-HTTP optional GET stream — return empty SSE so probing clients accept the endpoint.
    return new Response(': mcp\n\n', {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
    });
  }
  if (request.method !== 'POST') return errJson(405, 'Method not allowed');

  let body;
  try { body = await request.json(); } catch { return errJson(400, 'Invalid JSON'); }

  // Batch or single
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMcpMessage(m, env)))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  const res = await handleMcpMessage(body, env);
  return res ? json(res) : new Response(null, { status: 202, headers: CORS_HEADERS });
}

// ---------- Entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return text('tap-check ok\n');
    }
    if (url.pathname === '/mcp') {
      return handleMcp(request, env);
    }
    return handleRest(request, env, url);
  },
};
