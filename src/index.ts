// probectl.com Worker
//
// Static landing page is served from ./public by the assets pipeline; this
// Worker runs only on /docs, /docs/*, /api/*, /webhooks/* (see wrangler.jsonc
// `run_worker_first`).
//
// Docs live in the SEPARATE `probectl` repo (single source of truth, next to
// the code they document). This Worker pulls them at request time through the
// GitHub Contents API with a read-only fine-grained PAT, renders Markdown to
// HTML, and caches the result in Workers KV. A push webhook on the probectl
// repo bumps a cache "generation" key, so docs update seconds after a push —
// the website repo never contains doc content.

import { marked } from "marked";
import { gfmHeadingId } from "marked-gfm-heading-id";

marked.use(gfmHeadingId());

export interface Env {
  ASSETS: Fetcher;
  DOCS_CACHE: KVNamespace;
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;
}

const REPO = "imfeelingtheagi/probectl";
const BRANCH = "main";
const API = "https://api.github.com";
const DOC_TTL = 60 * 60 * 24; // generation bump invalidates sooner

const ghHeaders = (env: Env): Record<string, string> => ({
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "probectl-website",
});

// Canonical docs home is the SUBDOMAIN: docs.probectl.com/<route>.
// probectl.com/docs/* permanently redirects there; on localhost/workers.dev
// (no docs host) the /docs/* paths render in place so `wrangler dev` works.
const DOCS_HOST = "docs.probectl.com";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const host = url.hostname;
    const isDocsHost = host === DOCS_HOST || host.startsWith("docs.");
    const isProdApex = host === "probectl.com" || host === "www.probectl.com";

    if (path === "/webhooks/github" && req.method === "POST") return webhook(req, env);
    if (path === "/api/access" && req.method === "POST") return accessForm(req, env);

    if (isDocsHost) {
      const p = path.replace(/^\/+/, "").replace(/\/+$/, "");
      // shell assets resolve on this host too
      if (p === "docs-theme.css" || p === "fonts.css" || p.startsWith("fonts/"))
        return env.ASSETS.fetch(req);
      if (p === "") return docsIndex(env, "");
      if (p === "docs" || p.startsWith("docs/")) {
        // a copied probectl.com/docs/... path pasted onto this host
        const rest = p === "docs" ? "" : p.slice("docs/".length);
        return Response.redirect(`https://${DOCS_HOST}/${rest}${url.search}`, 301);
      }
      return docPage(p, env, "");
    }

    if (path === "/docs" || path === "/docs/") {
      if (isProdApex) return Response.redirect(`https://${DOCS_HOST}/`, 301);
      return docsIndex(env, "/docs"); // local dev / workers.dev preview
    }
    if (path.startsWith("/docs/")) {
      if (isProdApex)
        return Response.redirect(`https://${DOCS_HOST}${path.slice("/docs".length)}${url.search}`, 301);
      return docPage(path.slice("/docs/".length), env, "/docs");
    }

    // Anything else that reached the Worker: defer to static assets.
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------- docs ----

function safePath(raw: string): string | null {
  const p = raw.replace(/\/+$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9/_.-]*$/.test(p) || p.includes("..")) return null;
  return p;
}

const generation = async (env: Env): Promise<string> =>
  (await env.DOCS_CACHE.get("gen")) ?? "0";

// `prefix` is "" on docs.probectl.com (routes at the root) and "/docs" in
// local dev / preview. It shapes every generated link and the cache key.
async function docPage(raw: string, env: Env, prefix: string): Promise<Response> {
  const p = safePath(raw);
  if (!p) return new Response("Not found", { status: 404 });

  const gen = await generation(env);
  const key = `doc:${gen}:${prefix || "root"}:${p}`;
  const hit = await env.DOCS_CACHE.get(key);
  if (hit) return html(hit);

  const repoPath = p === "readme" ? "README.md" : `docs/${p}.md`;
  const r = await fetch(`${API}/repos/${REPO}/contents/${repoPath}?ref=${BRANCH}`, {
    headers: { ...ghHeaders(env), Accept: "application/vnd.github.raw+json" },
  });

  if (r.status === 404) return dirListing(p, env, key, prefix); // maybe a directory
  if (!r.ok) {
    const stale = await env.DOCS_CACHE.get(`doc:stale:${prefix || "root"}:${p}`);
    if (stale) return html(stale); // GitHub hiccup: serve last-known-good
    return new Response("Docs temporarily unavailable", { status: 503 });
  }

  const md = await r.text();
  const body = rewriteLinks(String(marked.parse(md)), p, prefix);
  const page = shell(docTitle(md, p), body, p, prefix);

  await env.DOCS_CACHE.put(key, page, { expirationTtl: DOC_TTL });
  await env.DOCS_CACHE.put(`doc:stale:${prefix || "root"}:${p}`, page); // no TTL: outage fallback
  return html(page);
}

async function docsIndex(env: Env, prefix: string): Promise<Response> {
  return dirListing("", env, `doc:${await generation(env)}:${prefix || "root"}:__index`, prefix);
}

// Renders a listing for docs/<dir> (the Contents API returns an array for
// directories). Also serves the docs index (dir = "").
async function dirListing(dir: string, env: Env, cacheKey: string, prefix: string): Promise<Response> {
  const hit = await env.DOCS_CACHE.get(cacheKey);
  if (hit) return html(hit);

  const r = await fetch(`${API}/repos/${REPO}/contents/docs${dir ? `/${dir}` : ""}?ref=${BRANCH}`, {
    headers: { ...ghHeaders(env), Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return new Response("No such doc", { status: 404 });
  if (!r.ok) return new Response("Docs temporarily unavailable", { status: 503 });

  const entries = (await r.json()) as Array<{ type: string; path: string; name: string }>;
  const items = entries
    .filter((e) => (e.type === "file" && e.name.endsWith(".md")) || e.type === "dir")
    .map((e) => {
      const route = e.path.replace(/^docs\//, "").replace(/\.md$/, "");
      return e.type === "dir"
        ? `<li class="dir"><a href="${prefix}/${route}">${e.name}/</a></li>`
        : `<li><a href="${prefix}/${route}">${e.name.replace(/\.md$/, "")}</a></li>`;
    })
    .join("\n");

  const heading = dir ? `docs/${dir}` : "Documentation";
  const intro = dir
    ? `<p><a href="${prefix || "/"}">← all docs</a></p>`
    : `<p>Live from the <a href="https://github.com/${REPO}">probectl repo</a> — start with the <a href="${prefix}/readme">README</a> or <a href="${prefix}/getting-started">getting started</a>.</p>`;
  const page = shell(heading, `<h1>${heading}</h1>${intro}<ul class="index">${items}</ul>`, dir, prefix);

  await env.DOCS_CACHE.put(cacheKey, page, { expirationTtl: DOC_TTL });
  return html(page);
}

// Docs cross-link each other as relative *.md paths — rewrite to site routes.
// `fromRoute` is the current doc route ("readme", "install",
// "agent/enrollment", ...). Links are resolved repo-relative: targets under
// docs/ become /docs/* routes, the root README becomes /docs/readme, and
// other repo files (CONTRIBUTING.md, SECURITY.md, ...) link to GitHub.
export function rewriteLinks(h: string, fromRoute: string, prefix: string): string {
  const repoDir =
    fromRoute === "readme"
      ? "" // README lives at the repo root
      : "docs" +
        (fromRoute.includes("/") ? "/" + fromRoute.slice(0, fromRoute.lastIndexOf("/")) : "");
  const segs = repoDir === "" ? [] : repoDir.split("/");

  return h.replace(/href="([^"]+)"/g, (m, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return m;
    const [path, anchor] = href.split("#");
    if (!path.endsWith(".md")) return m;

    let p = path.replace(/^(\.\/)+/, "");
    let up = 0;
    while (p.startsWith("../")) {
      up++;
      p = p.slice(3);
    }
    if (up > segs.length) return m; // escapes the repo — leave untouched

    const target = [...segs.slice(0, segs.length - up), p].join("/");
    const a = anchor ? `#${anchor}` : "";
    if (/^readme\.md$/i.test(target)) return `href="${prefix}/readme${a}"`;
    if (target.startsWith("docs/"))
      return `href="${prefix}/${target.slice(5).replace(/\.md$/, "")}${a}"`;
    return `href="https://github.com/${REPO}/blob/${BRANCH}/${target}${a}"`;
  });
}

function docTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return (m ? m[1] : fallback).replace(/[<>&]/g, "");
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Page shell. mermaid loads only when the page contains a mermaid block
// (e.g. /architecture); everything else ships zero JS.
// `route` is the doc route ("getting-started", "" for the index); the
// canonical URL always points at the production docs host.
function shell(title: string, body: string, route: string, prefix: string): string {
  const canonical = `https://${DOCS_HOST}/${route}`;
  const mermaid = body.includes('class="language-mermaid"')
    ? `<script type="module">
import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
document.querySelectorAll("code.language-mermaid").forEach((c) => {
  const d = document.createElement("pre");
  d.className = "mermaid"; d.textContent = c.textContent ?? "";
  (c.closest("pre") ?? c).replaceWith(d);
});
m.initialize({ startOnLoad: true, theme: "dark", securityLevel: "strict" });
</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · probectl docs</title>
<link rel="canonical" href="${canonical}">
<meta name="theme-color" content="#0a1024">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Crect width='20' height='20' rx='4' fill='%230a1024'/%3E%3Ccircle cx='10' cy='10' r='7' fill='none' stroke='%23ffb454' stroke-width='1.4'/%3E%3Ccircle cx='10' cy='10' r='2.6' fill='none' stroke='%23ffb454' stroke-width='1.4'/%3E%3Ccircle cx='10' cy='10' r='1.2' fill='%23ffb454'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/docs-theme.css">
</head>
<body class="docs">
<nav class="crumbs"><a href="https://probectl.com/">probectl</a><span>/</span><a href="${prefix || "/"}">docs</a><a class="gh" href="https://github.com/${REPO}" rel="noopener">GitHub ↗</a></nav>
<main>${body}</main>
<footer>Rendered live from <code>github.com/${REPO}</code> · <a href="/">probectl.com</a></footer>
${mermaid}
</body>
</html>`;
}

// --------------------------------------------------------------- webhook ---
// HMAC-SHA256 verification of X-Hub-Signature-256, per GitHub's documented
// Web-Crypto pattern (crypto.subtle.verify is constant-time).

async function webhook(req: Request, env: Env): Promise<Response> {
  const sig = req.headers.get("X-Hub-Signature-256") ?? "";
  const body = await req.text();
  if (!(await verifySignature(env.WEBHOOK_SECRET, sig, body)))
    return new Response("bad signature", { status: 401 });

  const event = req.headers.get("X-GitHub-Event");
  if (event === "ping") return new Response("pong");
  if (event !== "push") return new Response("ignored");

  const p = JSON.parse(body) as {
    ref?: string;
    commits?: Array<{ added: string[]; modified: string[]; removed: string[] }>;
  };
  if (p.ref !== `refs/heads/${BRANCH}`) return new Response("not " + BRANCH);

  const touched = (p.commits ?? []).some((c) =>
    [...c.added, ...c.modified, ...c.removed].some(
      (f) => f.startsWith("docs/") || f === "README.md",
    ),
  );
  if (touched) await env.DOCS_CACHE.put("gen", String(Date.now()));
  return new Response(touched ? "cache invalidated" : "no docs changes");
}

export async function verifySignature(
  secret: string,
  header: string,
  payload: string,
): Promise<boolean> {
  if (!header.startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length);
  if (hex.length % 2 !== 0) return false;
  const sig = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return false;
    sig[i / 2] = b;
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(payload));
}

// ------------------------------------------------------ early-access form --
// Replaces the third-party form processor: submissions stay on our infra.
// Export anytime:  npx wrangler kv key list --binding=DOCS_CACHE --prefix=access:

async function accessForm(req: Request, env: Env): Promise<Response> {
  let email = "";
  let network = "";
  try {
    const data = await req.formData();
    email = String(data.get("email") ?? "").trim();
    network = String(data.get("network") ?? "").trim().slice(0, 500);
  } catch {
    return json({ ok: false, error: "bad form" }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, error: "bad email" }, 400);

  await env.DOCS_CACHE.put(
    `access:${Date.now()}:${crypto.randomUUID()}`,
    JSON.stringify({ email, network, at: new Date().toISOString() }),
  );
  return json({ ok: true });
}

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });
