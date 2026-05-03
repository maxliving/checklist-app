# Tap Check

A mobile-first PWA for tappable checklists. Push them in from Claude over MCP, or paste JSON. Tap items to mark them done.

```
checklist-app/
├── web/         # Static PWA — deploy to Cloudflare Pages, Netlify, GitHub Pages, etc.
└── worker/      # Cloudflare Worker — REST API + MCP endpoint, KV-backed
```

See `tap_check_spec.md` (in your downloads, not committed) for the product spec.

---

## Local dev

### PWA

It's static, no build step. Serve `web/` with anything:

```bash
cd web && python3 -m http.server 8080
# open http://localhost:8080
```

To install on iOS: open in Safari → Share → Add to Home Screen.
On Android: open in Chrome → menu → Install app.

### Worker

```bash
cd worker
npm install
npx wrangler kv namespace create CHECKLISTS
# paste the returned id into wrangler.toml
npx wrangler dev
```

Set the worker URL in the PWA at `#/settings`.

---

## Deploy

### Worker

```bash
cd worker
npx wrangler secret put MCP_SECRET     # optional but recommended
npx wrangler deploy
```

After deploy, edit `wrangler.toml` and set `PUBLIC_BASE_URL` to the deployed PWA URL, then redeploy. This is what `push_checklist` uses to build the returned URL.

### PWA

Cloudflare Pages (recommended — same vendor):

```bash
cd web
npx wrangler pages deploy . --project-name tap-check
```

Or commit and connect the repo to Pages with `web/` as the build output directory and no build command.

---

## Claude MCP setup

Add the worker as an MCP server in Claude (Desktop or claude.ai connectors). Use the **streamable HTTP** transport.

| Field | Value |
|---|---|
| URL | `https://<your-worker>.workers.dev/mcp` |
| Auth header | `Authorization: Bearer <MCP_SECRET>` (only if you set the secret) |

Tools exposed:

- `push_checklist(checklist)` → `{ id, url }`. Stores a checklist; the PWA picks it up on next sync.
- `list_checklists()` → `[{ id, title, created_at }]`.
- `delete_checklist(id)` → `{ ok }`.

### Example prompt to Claude

> Build a PT routine for tomorrow morning — warm-up, posterior chain, lateral hip, push/pull. Push it to Tap Check.

Claude will call `push_checklist` with the right structure. Your phone polls on app focus, or hit Refresh.

---

## Data model

```json
{
  "id": "uuid",
  "title": "PT + push/pull — 5/3",
  "created_at": "2026-05-03T10:00:00Z",
  "sections": [
    {
      "label": "1 — Warm-up / mobility",
      "items": [
        { "text": "1/2 kneeling hip flexor stretch", "detail": "2x2, 20s hold" },
        { "text": "Supine 90/90 hip switch", "detail": "2x10" },
        { "text": "Scorpion stretch", "detail": null }
      ]
    }
  ]
}
```

`done` state is per-device — stored in `localStorage`, never synced. Re-pushing a checklist with the same `id` overwrites it server-side; local progress on that id is preserved. Re-ordered items will reset (item state is keyed by section/item index).

---

## Decisions vs. open questions in the spec

- **Detail visibility:** shown only on the highlighted next-up item (mockup behavior). One CSS rule to flip.
- **Auto-archive:** completed checklists stay until swiped. Many routines get re-opened the next day.
- **Auth:** optional `MCP_SECRET`. If set, all endpoints require it. The PWA stores it in localStorage.
- **MCP transport:** streamable HTTP (`POST /mcp`) instead of SSE — same Claude connector, one endpoint.
- **Sync:** on app focus, plus a manual Refresh button. No timer.
