# probectl-website

The probectl.com site: a static landing page plus **live documentation pulled
from the [`probectl`](https://github.com/imfeelingtheagi/probectl) repo** —
docs stay single-sourced next to the code; this repo contains zero doc
content, only the renderer.

## How it works

- `public/` — the landing page, served as static assets at the Cloudflare
  edge (the Worker is not invoked for these requests).
- `src/index.ts` — a Cloudflare Worker that runs only on `/docs*`, `/api/*`,
  and `/webhooks/*`:
  - `/docs/<path>` fetches `docs/<path>.md` from the probectl repo via the
    GitHub Contents API (read-only fine-grained PAT), renders it
    (marked + GFM heading ids, mermaid client-side), rewrites `*.md`
    cross-links to site routes, and caches the HTML in Workers KV.
    `/docs/readme` serves the repo README; directory paths render listings.
  - `/webhooks/github` — HMAC-verified push webhook from the probectl repo;
    a push touching `docs/**` or `README.md` bumps the cache generation, so
    published docs update seconds after a push.
  - `/api/access` — the early-access form endpoint (submissions stored in KV;
    no third-party form processor).
- Outage behavior: last-known-good copies are kept without TTL and served if
  GitHub is unreachable.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in GITHUB_TOKEN + WEBHOOK_SECRET
npm run dev                      # http://localhost:8787  (+ /docs)
npm run check                    # typecheck
```

## Deploy (first time)

1. `npx wrangler kv namespace create DOCS_CACHE` → paste the id into
   `wrangler.jsonc`.
2. `npx wrangler secret put GITHUB_TOKEN` and
   `npx wrangler secret put WEBHOOK_SECRET`.
3. `npm run deploy` — the `routes` block attaches `probectl.com` +
   `www.probectl.com` (zone must be active on the Cloudflare account).
4. Add the push webhook on the probectl repo →
   `https://probectl.com/webhooks/github`, content type `application/json`,
   the same secret, "Just the push event".
5. Optional: connect this repo in the Cloudflare dash (Worker → Settings →
   Builds) for push-to-deploy.

The full verified runbook (PAT scoping, webhook test vector, rate-limit
budget, launch checklist) lives in the internal planning doc
`probectl-website-plan.md`.
