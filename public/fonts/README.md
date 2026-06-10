# Self-hosted webfonts (launch task)

The landing page currently loads Syne, Sora, and DM Mono from Google Fonts —
third-party requests that should not ship on a sovereignty-branded site.

Before launch:

1. Download the woff2 files (e.g. via https://gwfh.mranftl.com — select
   Syne 600/700/800, Sora 400/500/600, DM Mono 400/500, format woff2) into
   this directory.
2. In `public/index.html`, delete the two `fonts.googleapis.com` / `gstatic`
   `<link rel="preconnect">` tags and the stylesheet `<link>`, and replace
   them with local `@font-face` rules:

```css
@font-face { font-family: 'Syne'; font-weight: 700; font-display: swap;
  src: url('/fonts/syne-v18-latin-700.woff2') format('woff2'); }
/* ...one rule per family/weight... */
```

3. Optionally add the same rules to `docs-theme.css` (it currently falls back
   to the system stack, which is acceptable).

The fallback stacks in the CSS keep both pages fully functional if fonts
never load, so this is a polish task, not a blocker for iteration.
