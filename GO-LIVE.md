# Go-live runbook — probectl.com (ELI5, do top to bottom)

You have: the domain on Cloudflare, both repos on GitHub, the site code in
this folder. Everything below happens in **Terminal on your Mac** and two
browser tabs (GitHub + Cloudflare dashboard). ~15 minutes.

---

## Step 0 — open Terminal in the website folder, push the newest code

```sh
cd ~/Desktop/cowork-probectl/probectl-website
git push
```

Check your tools:

```sh
node -v    # must say v22 or higher
```

If it says v20/v18: `brew install node` (or use nvm), reopen Terminal, check again.

```sh
npm install
```

## Step 1 — make the GitHub "reading key" (PAT)

The Worker needs permission to read the probectl repo's docs.

1. Browser → github.com → click your avatar (top right) → **Settings**.
2. Left sidebar, bottom → **Developer settings**.
3. **Personal access tokens → Fine-grained tokens → Generate new token**.
4. Name: `probectl-website-docs`. Expiration: 90 days (set a reminder to rotate).
5. **Repository access**: choose **Only select repositories** → pick `probectl`.
6. **Permissions → Repository permissions → Contents → Read-only.** Touch nothing else.
7. **Generate token** → it shows a long string starting `github_pat_…` →
   **copy it into a note for the next 5 minutes.**

## Step 2 — make the webhook password

In Terminal:

```sh
openssl rand -hex 32
```

It prints a long random string. **Copy it into the same note.** You'll paste
it twice (Cloudflare + GitHub) — both sides must match exactly.

## Step 3 — log in to Cloudflare from Terminal

```sh
npx wrangler login
```

A browser tab opens → click **Allow**. Terminal says you're logged in.

## Step 4 — create the cache and tell the config its id

```sh
npx wrangler kv namespace create DOCS_CACHE
```

It prints something like:

```
{ "binding": "DOCS_CACHE", "id": "a1b2c3d4e5f6..." }
```

Open `wrangler.jsonc` in this folder and replace
`REPLACE_WITH_KV_NAMESPACE_ID` with that id (keep the quotes). Save, then:

```sh
git add wrangler.jsonc && git commit -s -m "chore: set DOCS_CACHE namespace id" && git push
```

## Step 5 — deploy (this is the moment the site goes live)

```sh
npm run deploy
```

This uploads the Worker + the landing page AND creates DNS + HTTPS
certificates for **probectl.com**, **www.probectl.com**, and
**docs.probectl.com** automatically.

If it complains a DNS record already exists for one of those names:
Cloudflare dashboard → probectl.com → **DNS → Records** → delete that
record → run `npm run deploy` again.

Test now: open **https://probectl.com** — the landing page should be up.
(Docs will say "temporarily unavailable" until Step 6 — expected.)

## Step 6 — give the Worker its two secrets

```sh
npx wrangler secret put GITHUB_TOKEN
```

→ it asks for the value: **paste the `github_pat_…` from Step 1**, Enter.

```sh
npx wrangler secret put WEBHOOK_SECRET
```

→ **paste the random string from Step 2**, Enter.

(Each command auto-deploys a new version — nothing else to do.)

Test now: open **https://docs.probectl.com** → you should see the live doc
index pulled from GitHub. Click **getting-started**. Also try
**https://probectl.com/docs/architecture** — it should bounce you to
**docs.probectl.com/architecture**.

## Step 7 — wire the "docs update themselves" webhook

1. Browser → **github.com/imfeelingtheagi/probectl** → **Settings → Webhooks → Add webhook**.
2. **Payload URL**: `https://probectl.com/webhooks/github`
3. **Content type**: `application/json`
4. **Secret**: paste the random string from Step 2.
5. **Which events?** → "Just the push event."
6. Click **Add webhook**.
7. Refresh the page → click the webhook → **Recent Deliveries** → the `ping`
   should have a green ✓. Red ✗ means the secret doesn't match — re-do
   Step 6's `WEBHOOK_SECRET` and GitHub's Secret field so they're identical.

Prove the loop: edit any file in `probectl/docs/` on GitHub (pencil icon →
commit to main) → wait ~10 seconds → reload that page on docs.probectl.com →
your edit is live.

## Step 8 — test the early-access form

On https://probectl.com, scroll to the bottom form, enter your own email,
submit. You should see the green "You're on the list" message. Read the
stored signups anytime:

```sh
npx wrangler kv key list --binding=DOCS_CACHE --remote --prefix=access:
```

## Step 9 (optional, 2 min each)

- **Visitor counts without trackers**: Cloudflare dashboard → **Analytics &
  Logs → Web Analytics** → add site `probectl.com` → copy the snippet → paste
  it where `public/index.html` says `LAUNCH TASK: measurement` → commit, push,
  `npm run deploy`.
- **Auto-deploy on git push**: Cloudflare dashboard → **Workers & Pages →
  probectl-website → Settings → Builds → Connect** → pick the
  `probectl-website` repo → save. From then on `git push` = deploy, and you
  can skip `npm run deploy`.
- **Burn the note** with the PAT + secret (they now live only in Cloudflare/GitHub).

## If something breaks

| Symptom | Fix |
|---|---|
| Any wrangler command crashes with "workerd … another platform" | `node_modules` was installed on a different OS (e.g. by a Linux tool into this shared folder). `rm -rf node_modules && npm install`, retry |
| `secret put` confusion | The word after `put` is the secret's NAME (`GITHUB_TOKEN` / `WEBHOOK_SECRET`); the value is pasted at the hidden prompt that follows — never on the command line |
| Deploy fails mentioning DNS/record | Delete that DNS record in the dash (Step 5 note), redeploy |
| docs.probectl.com says "temporarily unavailable" | Secrets missing/typo'd — redo Step 6 |
| Webhook delivery red ✗ | Secrets don't match — redo Step 2's value on both sides |
| Docs don't update after a push | Webhook → Recent Deliveries → was it sent? Did the push touch `docs/**` on `main`? |
| Landing page fine, docs 404 on a page | That doc path doesn't exist in `probectl/docs/` — check the spelling |
