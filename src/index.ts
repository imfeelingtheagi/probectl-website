// probectl.com Worker
//
// Static landing page is served from ./public by the assets pipeline; this
// Worker runs on /docs*, /api/*, /webhooks/*, and everything on the docs host.
//
// Docs live in the SEPARATE `probectl` repo (single source of truth, next to
// the code they document). This Worker pulls them at request time through the
// GitHub Contents API with a read-only fine-grained PAT, renders Markdown to
// HTML inside a full docs layout (sidebar nav, search, TOC, prev/next), and
// caches the result in Workers KV. A push webhook on the probectl repo bumps a
// cache "generation" key, so docs update seconds after a push.

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
const DOCS_HOST = "docs.probectl.com";
// Bump whenever shell()/rendering changes shape: it versions every cache key,
// so a deploy instantly stops serving pages rendered by older code (no
// reliance on KV `gen` propagation for layout changes).
const CACHE_V = "v3";

const ghHeaders = (env: Env): Record<string, string> => ({
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "probectl-website",
});

// ----------------------------------------------------------- navigation ----
// Curated sidebar. Routes are docs/ paths without .md ("readme" = repo README).
// Docs that exist in the repo but not here still work via search and listings.

type NavItem = { route: string; label: string };
type NavSection = { title: string; items: NavItem[] };

const NAV: NavSection[] = [
  { title: "Start here", items: [
    { route: "readme", label: "Overview" },
    { route: "getting-started", label: "Getting started" },
    { route: "deploying-agents", label: "Deploying agents" },
    { route: "install", label: "Install & deploy" },
    { route: "admin", label: "Day-2 admin" },
  ]},
  { title: "Observability planes", items: [
    { route: "flow", label: "Flow analytics" },
    { route: "otlp", label: "OTLP ingest & export" },
    { route: "otel-mapping", label: "OTel semantic mapping" },
    { route: "device-telemetry", label: "Device telemetry" },
    { route: "ebpf-agent", label: "eBPF host agent" },
    { route: "ebpf-feasibility", label: "eBPF feasibility" },
    { route: "agent-overhead", label: "Agent overhead" },
    { route: "rum", label: "Real user monitoring" },
    { route: "browser-synthetic", label: "Browser synthetic" },
    { route: "endpoint-dem", label: "Endpoint DEM" },
    { route: "topology", label: "Topology & what-if" },
    { route: "tls-observability", label: "TLS observability" },
    { route: "voice", label: "Voice quality" },
  ]},
  { title: "Architecture", items: [
    { route: "architecture", label: "Architecture" },
    { route: "editions", label: "Editions & licensing" },
    { route: "isolation", label: "Tenant isolation models" },
    { route: "provider-plane", label: "Provider / MSP plane" },
    { route: "multi-region", label: "Multi-region HA" },
    { route: "scale-gate", label: "Scale gate" },
    { route: "lifecycle", label: "Upgrades & lifecycle" },
    { route: "white-label", label: "White-label" },
  ]},
  { title: "AI", items: [
    { route: "ai-rca", label: "Root-cause analysis" },
    { route: "ai-query", label: "Semantic query" },
    { route: "ai-authoring", label: "AI authoring" },
    { route: "ai-egress", label: "AI egress & sovereignty" },
    { route: "mcp", label: "MCP server" },
  ]},
  { title: "Security & identity", items: [
    { route: "security/threat-model", label: "Threat model" },
    { route: "security/tenant-isolation", label: "Tenant isolation (enforcement)" },
    { route: "security/agent-whitepaper", label: "Agent security whitepaper" },
    { route: "security/incident-response", label: "Incident response" },
    { route: "hardening", label: "Hardening & FIPS" },
    { route: "byok", label: "BYOK" },
    { route: "secrets", label: "Secrets handling" },
    { route: "scim-abac", label: "SCIM & ABAC" },
    { route: "auth/self-hosted-idp", label: "Self-hosted IdP" },
    { route: "ndr", label: "NDR signals" },
    { route: "threat-intel", label: "Threat intelligence" },
    { route: "siem", label: "SIEM export" },
    { route: "compliance", label: "Compliance" },
    { route: "governance", label: "Data governance" },
    { route: "opendata-aup", label: "Open-data AUP" },
  ]},
  { title: "Agents & enrollment", items: [
    { route: "agent/enrollment", label: "Agent enrollment" },
    { route: "adr/agent-enrollment", label: "ADR: enrollment" },
    { route: "adr/config-push", label: "ADR: config push" },
    { route: "adr/volatile-stores", label: "ADR: volatile stores" },
    { route: "ops/fleet-rollout", label: "Fleet rollout" },
  ]},
  { title: "Operations", items: [
    { route: "ops/backup-restore", label: "Backup & restore" },
    { route: "ops/dr", label: "Disaster recovery" },
    { route: "ops/verify-artifacts", label: "Verify artifacts" },
    { route: "ops/branch-protection", label: "Branch protection" },
    { route: "runbooks/region-failover", label: "Runbook: region failover" },
    { route: "runbooks/tenant-offboarding", label: "Runbook: tenant offboarding" },
    { route: "outage", label: "Internet outage view" },
    { route: "oncall-itsm", label: "On-call & ITSM" },
    { route: "chaos", label: "Chaos / fault injection" },
    { route: "iac-gitops", label: "IaC & GitOps" },
    { route: "supportability", label: "Support bundles" },
  ]},
  { title: "SLO, cost & alerting", items: [
    { route: "slo", label: "SLO engine" },
    { route: "finops", label: "FinOps" },
    { route: "carbon", label: "Carbon" },
    { route: "metering", label: "Metering & billing" },
    { route: "fairness", label: "Fairness limits" },
    { route: "change-intel", label: "Change intelligence" },
    { route: "alerting", label: "Alerting" },
    { route: "remediation", label: "Guarded remediation" },
    { route: "ecosystem-integrations", label: "Ecosystem integrations" },
  ]},
  { title: "Reference", items: [
    { route: "configuration", label: "Configuration (every key)" },
    { route: "development", label: "Development" },
    { route: "ci-pipeline", label: "CI pipeline" },
    { route: "releasing", label: "Releasing" },
    { route: "dependency-policy", label: "Dependency policy" },
    { route: "build/toolchain", label: "Build toolchain" },
    { route: "perf-baseline", label: "Performance baseline" },
    { route: "quality/coverage", label: "Coverage" },
    { route: "frontend-coverage", label: "Frontend coverage" },
    { route: "dev/repo-hygiene", label: "Repo hygiene" },
    { route: "third-party-licenses", label: "Third-party licenses" },
  ]},
];
const NAV_FLAT: NavItem[] = NAV.flatMap((s) => s.items);

// ------------------------------------------------------------- routing ----
// Canonical docs home is the SUBDOMAIN: docs.probectl.com/<route>.
// probectl.com/docs/* permanently redirects there; on localhost/workers.dev
// (no docs host) the /docs/* paths render in place so `wrangler dev` works.

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const host = url.hostname;
    const isDocsHost = host === DOCS_HOST || host.startsWith("docs.");
    const isProdApex = host === "probectl.com" || host === "www.probectl.com";

    if (path === "/webhooks/github" && req.method === "POST") return webhook(req, env);
    if (path === "/api/access" && req.method === "POST") return accessForm(req, env);
    if (path === "/api/search-index") return searchIndex(env);

    if (isDocsHost) {
      const p = path.replace(/^\/+/, "").replace(/\/+$/, "");
      if (p === "docs-theme.css" || p === "fonts.css" || p.startsWith("fonts/"))
        return env.ASSETS.fetch(req);
      if (p === "robots.txt")
        return new Response(`User-agent: *\nAllow: /\n\nSitemap: https://${DOCS_HOST}/sitemap.xml\n`, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      if (p === "sitemap.xml") return sitemap();
      if (p === "") return docsHome(env, "");
      if (p === "docs" || p.startsWith("docs/")) {
        const rest = p === "docs" ? "" : p.slice("docs/".length);
        return Response.redirect(`https://${DOCS_HOST}/${rest}${url.search}`, 301);
      }
      return docPage(p, env, "");
    }

    if (path === "/docs" || path === "/docs/") {
      if (isProdApex) return Response.redirect(`https://${DOCS_HOST}/`, 301);
      return docsHome(env, "/docs"); // local dev / workers.dev preview
    }
    if (path.startsWith("/docs/")) {
      if (isProdApex)
        return Response.redirect(`https://${DOCS_HOST}${path.slice("/docs".length)}${url.search}`, 301);
      return docPage(path.slice("/docs/".length), env, "/docs");
    }

    // The landing page itself ("/" is worker-first): add security headers.
    if (path === "/" || path === "/index.html") {
      const res = await env.ASSETS.fetch(req);
      const h = new Headers(res.headers);
      h.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      h.set("Referrer-Policy", "strict-origin-when-cross-origin");
      h.set("X-Frame-Options", "DENY");
      return new Response(res.body, { status: res.status, headers: h });
    }
    return env.ASSETS.fetch(req); // other static assets
  },
} satisfies ExportedHandler<Env>;

function sitemap(): Response {
  const urls = ["", ...NAV_FLAT.map((n) => n.route)]
    .map((r) => `<url><loc>https://${DOCS_HOST}/${r}</loc></url>`)
    .join("");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
}

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
  if (!p) return notFound(prefix);

  const gen = await generation(env);
  const key = `doc:${CACHE_V}:${gen}:${prefix || "root"}:${p}`;
  const hit = await env.DOCS_CACHE.get(key);
  if (hit) return html(hit);

  const repoPath = p === "readme" ? "README.md" : `docs/${p}.md`;
  const r = await fetch(`${API}/repos/${REPO}/contents/${repoPath}?ref=${BRANCH}`, {
    headers: { ...ghHeaders(env), Accept: "application/vnd.github.raw+json" },
  });

  if (r.status === 404) return dirListing(p, env, key, prefix); // maybe a directory
  if (!r.ok) {
    const stale = await env.DOCS_CACHE.get(`doc:stale:${CACHE_V}:${prefix || "root"}:${p}`);
    if (stale) return html(stale); // GitHub hiccup: serve last-known-good
    return new Response("Docs temporarily unavailable", { status: 503 });
  }

  const md = await r.text();
  const body = rewriteLinks(String(marked.parse(md)), p, prefix);
  const page = shell(docTitle(md, p), `<article>${body}</article>${prevNext(p, prefix)}`, p, prefix, true);

  await env.DOCS_CACHE.put(key, page, { expirationTtl: DOC_TTL });
  await env.DOCS_CACHE.put(`doc:stale:${CACHE_V}:${prefix || "root"}:${p}`, page); // no TTL: outage fallback
  return html(page);
}

// Docs landing: curated section cards. Pure render — no GitHub call.
async function docsHome(env: Env, prefix: string): Promise<Response> {
  const cards = NAV.map(
    (s) => `<section class="home-sec"><h2>${s.title}</h2><ul>${s.items
      .map((i) => `<li><a href="${prefix}/${i.route}">${i.label}</a></li>`)
      .join("")}</ul></section>`,
  ).join("\n");
  const body = `<article class="home">
<h1>Documentation</h1>
<p class="home-lead">Rendered live from <a href="https://github.com/${REPO}">the probectl repo</a> —
what you read here is what is on <code>${BRANCH}</code>. New here? Start with
<a href="${prefix}/getting-started">getting started: zero to first real data</a>.
Press <kbd>⌘K</kbd> to search.</p>
<div class="home-grid">${cards}</div></article>`;
  return html(shell("Documentation", body, "", prefix, false));
}

// Directory listing for docs/<dir> (Contents API returns an array for dirs).
async function dirListing(dir: string, env: Env, cacheKey: string, prefix: string): Promise<Response> {
  const hit = await env.DOCS_CACHE.get(cacheKey);
  if (hit) return html(hit);

  const r = await fetch(`${API}/repos/${REPO}/contents/docs/${dir}?ref=${BRANCH}`, {
    headers: { ...ghHeaders(env), Accept: "application/vnd.github+json" },
  });
  if (r.status === 404) return notFound(prefix);
  if (!r.ok) return new Response("Docs temporarily unavailable", { status: 503 });

  const entries = (await r.json()) as Array<{ type: string; path: string; name: string }>;
  const items = entries
    .filter((e) => (e.type === "file" && e.name.endsWith(".md")) || e.type === "dir")
    .map((e) => {
      const route = e.path.replace(/^docs\//, "").replace(/\.md$/, "");
      return `<li><a href="${prefix}/${route}">${e.name.replace(/\.md$/, "")}${e.type === "dir" ? "/" : ""}</a></li>`;
    })
    .join("\n");
  const body = `<article><h1>docs/${dir}</h1><p><a href="${prefix || "/"}">← all docs</a></p><ul class="index">${items}</ul></article>`;
  const page = shell(`docs/${dir}`, body, dir, prefix, false);
  await env.DOCS_CACHE.put(cacheKey, page, { expirationTtl: DOC_TTL });
  return html(page);
}

// --------------------------------------------------------------- search ----
// Self-hosted search: a JSON index of every doc (title, headings, excerpt),
// built lazily in shards of ≤25 GitHub fetches per request (free-plan
// subrequest-safe), cached in KV per generation. The client (in shell())
// fetches /api/search-index and scores matches locally — no third-party
// search service, nothing leaves the site.

type IndexDoc = { r: string; t: string; h: string[]; x: string };
type SearchIdx = { status: "building" | "complete"; done: number; docs: IndexDoc[] };

async function docPaths(env: Env, gen: string): Promise<string[]> {
  const key = `paths:${CACHE_V}:${gen}`;
  const hit = await env.DOCS_CACHE.get(key);
  if (hit) return JSON.parse(hit) as string[];

  const routes: string[] = ["readme"];
  const dirs: string[] = [""];
  while (dirs.length) {
    const d = dirs.shift()!;
    const r = await fetch(`${API}/repos/${REPO}/contents/docs${d ? `/${d}` : ""}?ref=${BRANCH}`, {
      headers: { ...ghHeaders(env), Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`list docs${d ? `/${d}` : ""}: ${r.status}`);
    for (const e of (await r.json()) as Array<{ type: string; path: string; name: string }>) {
      const route = e.path.replace(/^docs\//, "").replace(/\.md$/, "");
      if (e.type === "dir") dirs.push(route);
      else if (e.name.endsWith(".md")) routes.push(route);
    }
  }
  await env.DOCS_CACHE.put(key, JSON.stringify(routes), { expirationTtl: DOC_TTL });
  return routes;
}

async function searchIndex(env: Env): Promise<Response> {
  const gen = await generation(env);
  const key = `searchidx:${CACHE_V}:${gen}`;
  const raw = await env.DOCS_CACHE.get(key);
  let idx: SearchIdx = raw ? (JSON.parse(raw) as SearchIdx) : { status: "building", done: 0, docs: [] };
  if (idx.status === "complete") return json(idx);

  let paths: string[];
  try {
    paths = await docPaths(env, gen);
  } catch {
    return json(idx); // GitHub hiccup: return whatever we have
  }

  const batch = paths.slice(idx.done, idx.done + 25);
  const results = await Promise.all(
    batch.map(async (p): Promise<IndexDoc | null> => {
      const repoPath = p === "readme" ? "README.md" : `docs/${p}.md`;
      const r = await fetch(`${API}/repos/${REPO}/contents/${repoPath}?ref=${BRANCH}`, {
        headers: { ...ghHeaders(env), Accept: "application/vnd.github.raw+json" },
      });
      if (!r.ok) return null;
      return mdToIndexDoc(p, await r.text());
    }),
  );
  idx.docs.push(...results.filter((d): d is IndexDoc => d !== null));
  idx.done += batch.length;
  if (idx.done >= paths.length) idx.status = "complete";
  await env.DOCS_CACHE.put(key, JSON.stringify(idx), { expirationTtl: DOC_TTL });
  return json(idx);
}

export function mdToIndexDoc(route: string, md: string): IndexDoc {
  // strip code fences AND raw HTML blocks (the README uses them) from the index
  const noCode = md.replace(/```[\s\S]*?```/g, " ").replace(/<[^>]*>/g, " ");
  const fallback = route === "readme" ? "Overview (README)" : route;
  const t = (noCode.match(/^#\s+(.+)$/m)?.[1] ?? fallback).replace(/[*_`#]/g, "").trim();
  const h = [...noCode.matchAll(/^#{2,3}\s+(.+)$/gm)]
    .map((m) => m[1].replace(/[*_`#]/g, "").trim())
    .slice(0, 24);
  const x = noCode
    .replace(/^#.+$/gm, " ")
    .replace(/[*_`>\[\]()|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
  return { r: route, t, h, x };
}

// ----------------------------------------------------------- rendering ----

// Docs cross-link each other as relative paths — rewrite to site routes.
// Targets under docs/ become routes, the root README becomes /readme, and any
// other repo file (compose YAML, fixtures, CONTRIBUTING.md, ...) → GitHub.
export function rewriteLinks(h: string, fromRoute: string, prefix: string): string {
  const repoDir =
    fromRoute === "readme"
      ? ""
      : "docs" + (fromRoute.includes("/") ? "/" + fromRoute.slice(0, fromRoute.lastIndexOf("/")) : "");
  const segs = repoDir === "" ? [] : repoDir.split("/");

  return h.replace(/href="([^"]+)"/g, (m, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href)) return m;
    const [path, anchor] = href.split("#");

    let p = path.replace(/^(\.\/)+/, "");
    let up = 0;
    while (p.startsWith("../")) {
      up++;
      p = p.slice(3);
    }
    if (up > segs.length || p === "") return m; // escapes the repo — leave untouched

    const target = [...segs.slice(0, segs.length - up), p].join("/");
    const a = anchor ? `#${anchor}` : "";

    if (path.endsWith(".md")) {
      if (/^readme\.md$/i.test(target)) return `href="${prefix}/readme${a}"`;
      if (target.startsWith("docs/"))
        return `href="${prefix}/${target.slice(5).replace(/\.md$/, "")}${a}"`;
      return `href="https://github.com/${REPO}/blob/${BRANCH}/${target}${a}"`;
    }
    const kind = target.endsWith("/") ? "tree" : "blob";
    return `href="https://github.com/${REPO}/${kind}/${BRANCH}/${target.replace(/\/$/, "")}${a}"`;
  });
}

function docTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return (m ? m[1] : fallback).replace(/[<>&*_`]/g, "");
}

function prevNext(route: string, prefix: string): string {
  const i = NAV_FLAT.findIndex((n) => n.route === route);
  if (i === -1) return "";
  const prev = NAV_FLAT[i - 1];
  const next = NAV_FLAT[i + 1];
  return `<nav class="prevnext">
${prev ? `<a class="pn prev" href="${prefix}/${prev.route}"><span>← Previous</span>${prev.label}</a>` : "<span></span>"}
${next ? `<a class="pn next" href="${prefix}/${next.route}"><span>Next →</span>${next.label}</a>` : "<span></span>"}
</nav>`;
}

function sidebar(route: string, prefix: string): string {
  return NAV.map((s) => {
    const open = s.items.some((i) => i.route === route);
    const items = s.items
      .map(
        (i) =>
          `<li${i.route === route ? ' class="active"' : ""}><a href="${prefix}/${i.route}">${i.label}</a></li>`,
      )
      .join("");
    return `<details${open ? " open" : ""}><summary>${s.title}</summary><ul>${items}</ul></details>`;
  }).join("\n");
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    },
  });
}

function notFound(prefix: string): Response {
  const body = `<article><h1>That page doesn't exist</h1>
<p>No doc lives at this address. It may have moved when the docs were reorganized.</p>
<p>Try the <a href="${prefix || "/"}">documentation index</a>, or press <kbd>⌘K</kbd> and search for it.</p></article>`;
  return html(shell("Not found", body, "", prefix, false), 404);
}

// Full docs layout: header (brand, search, GitHub) · sidebar · article · TOC.
// All enhancement JS is inline vanilla (search, TOC, copy buttons, drawer) —
// the only external script is mermaid, loaded only on pages that need it.
function shell(title: string, body: string, route: string, prefix: string, withToc: boolean): string {
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
<body class="docs" data-prefix="${prefix}">
<header class="top">
  <button class="navbtn" aria-label="Menu" aria-expanded="false">☰</button>
  <a class="brand" href="https://probectl.com/"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="#ffb454" stroke-width="1.4"/><circle cx="10" cy="10" r="3.3" fill="none" stroke="#ffb454" stroke-width="1.4"/><circle cx="10" cy="10" r="1.4" fill="#ffb454"/></svg>probectl</a>
  <span class="sep">/</span><a class="docsroot" href="${prefix || "/"}">docs</a>
  <button class="searchbtn" aria-label="Search docs"><span>Search…</span><kbd>⌘K</kbd></button>
  <a class="gh" href="https://github.com/${REPO}" rel="noopener">GitHub ↗</a>
</header>
<div class="layout">
  <nav class="side" aria-label="Documentation">${sidebar(route, prefix)}</nav>
  <main>${body}
  <footer>Rendered live from <code>github.com/${REPO}</code>${withToc ? ` — found a mistake? <a href="https://github.com/${REPO}/edit/${BRANCH}/${route === "readme" ? "README.md" : `docs/${route}.md`}" rel="noopener">edit this page</a>` : ""}.</footer>
  </main>
  ${withToc ? `<aside class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul id="tocList"></ul></aside>` : ""}
</div>
<div class="search-overlay" hidden>
  <div class="search-box">
    <input id="searchInput" type="search" placeholder="Search the docs…" autocomplete="off">
    <div id="searchStatus" class="search-status"></div>
    <ul id="searchResults"></ul>
  </div>
</div>
<script>
(function(){
"use strict";
var prefix=document.body.dataset.prefix||"";

// sidebar drawer (mobile)
var nb=document.querySelector(".navbtn"),side=document.querySelector(".side");
if(nb)nb.addEventListener("click",function(){var o=document.body.classList.toggle("nav-open");nb.setAttribute("aria-expanded",o?"true":"false");});

// table of contents from h2/h3 + scroll highlight
var toc=document.getElementById("tocList");
if(toc){
  var hs=document.querySelectorAll("main article h2, main article h3");
  hs.forEach(function(h){
    if(!h.id)return;
    var li=document.createElement("li");li.className=h.tagName.toLowerCase();
    var a=document.createElement("a");a.href="#"+h.id;a.textContent=h.textContent.replace(/¶$/,"");
    li.appendChild(a);toc.appendChild(li);
  });
  if(!toc.children.length){var t=document.querySelector(".toc");if(t)t.remove();}
  else if("IntersectionObserver" in window){
    var links={};toc.querySelectorAll("a").forEach(function(a){links[a.getAttribute("href").slice(1)]=a;});
    var io=new IntersectionObserver(function(es){es.forEach(function(e){
      var a=links[e.target.id];if(!a)return;
      if(e.isIntersecting){toc.querySelectorAll("a.on").forEach(function(x){x.classList.remove("on")});a.classList.add("on");}
    });},{rootMargin:"0px 0px -75% 0px"});
    hs.forEach(function(h){if(h.id)io.observe(h)});
  }
}

// heading anchor links
document.querySelectorAll("main article h2[id], main article h3[id]").forEach(function(h){
  var a=document.createElement("a");a.className="hanchor";a.href="#"+h.id;a.textContent="¶";h.appendChild(a);
});

// copy buttons on code blocks
document.querySelectorAll("main article pre").forEach(function(pre){
  if(pre.classList.contains("mermaid"))return;
  var b=document.createElement("button");b.className="copy";b.textContent="copy";
  b.addEventListener("click",function(){
    navigator.clipboard.writeText(pre.innerText).then(function(){b.textContent="copied";setTimeout(function(){b.textContent="copy"},1200);});
  });
  pre.appendChild(b);
});

// search: lazy index fetch (sharded server build), local scoring
var overlay=document.querySelector(".search-overlay"),input=document.getElementById("searchInput"),
    results=document.getElementById("searchResults"),status=document.getElementById("searchStatus");
var idx=null,loading=false;
function openSearch(){overlay.hidden=false;input.value="";results.innerHTML="";input.focus();loadIdx();}
function closeSearch(){overlay.hidden=true;}
function loadIdx(){
  if(loading||(idx&&idx.status==="complete"))return;
  loading=true;status.textContent="indexing…";
  fetch("/api/search-index").then(function(r){return r.json()}).then(function(j){
    idx=j;loading=false;
    if(j.status!=="complete"){status.textContent="indexing "+j.done+" docs…";setTimeout(loadIdx,400);}
    else{status.textContent="";if(input.value)render(input.value);}
  }).catch(function(){loading=false;status.textContent="search unavailable";});
}
function render(q){
  if(!idx){results.innerHTML="";return;}
  var toks=q.toLowerCase().split(/\\s+/).filter(Boolean);
  if(!toks.length){results.innerHTML="";return;}
  var scored=idx.docs.map(function(d){
    var s=0,hay_t=d.t.toLowerCase(),hay_h=d.h.join(" | ").toLowerCase(),hay_x=d.x.toLowerCase();
    toks.forEach(function(tok){
      if(hay_t.indexOf(tok)>=0)s+=5;
      if(hay_h.indexOf(tok)>=0)s+=3;
      if(hay_x.indexOf(tok)>=0)s+=1;
      if(d.r.toLowerCase().indexOf(tok)>=0)s+=2;
    });
    return [s,d];
  }).filter(function(p){return p[0]>0}).sort(function(a,b){return b[0]-a[0]}).slice(0,12);
  results.innerHTML=scored.map(function(p){
    var d=p[1];
    var hit=d.h.find(function(h){return toks.some(function(t){return h.toLowerCase().indexOf(t)>=0})});
    return '<li><a href="'+prefix+'/'+d.r+'"><b>'+d.t+'</b>'+(hit?'<i>'+hit+'</i>':'')+'<span>'+d.r+'</span></a></li>';
  }).join("")||'<li class="none">No matches.</li>';
}
input&&input.addEventListener("input",function(){render(input.value)});
document.querySelector(".searchbtn").addEventListener("click",openSearch);
document.addEventListener("keydown",function(e){
  if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();overlay.hidden?openSearch():closeSearch();}
  else if(e.key==="Escape"&&!overlay.hidden)closeSearch();
  else if(e.key==="/"&&overlay.hidden&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)){e.preventDefault();openSearch();}
});
overlay.addEventListener("click",function(e){if(e.target===overlay)closeSearch();});
})();
</script>
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
// Submissions stay on our infra. Export anytime:
//   npx wrangler kv key list --binding=DOCS_CACHE --remote --prefix=access:

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
