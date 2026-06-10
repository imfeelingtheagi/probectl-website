# Self-hosted webfonts

Syne (600/700/800), Sora (400/500/600), and DM Mono (400/500) — latin woff2
subsets, served first-party from this directory via `/fonts.css`. No visitor
request ever goes to a third-party font CDN.

Provenance: copied from the `@fontsource/syne`, `@fontsource/sora`, and
`@fontsource/dm-mono` npm packages (pinned in `package.json` devDependencies).
All three families are licensed under the **SIL Open Font License 1.1** —
full texts in `LICENSE-*.txt` alongside the font files.

To update: bump the @fontsource packages, re-copy the
`files/<family>-latin-<weight>-normal.woff2` files here.
