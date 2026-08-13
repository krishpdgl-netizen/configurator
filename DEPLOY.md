# Deploying to Render + Neon

The database is Postgres now, not a SQLite file. Nothing is stored on the
server's disk except tender uploads, which are deleted as soon as the text
has been extracted. That means the app can restart, redeploy or move machines
without losing anything.

## 1. Create the database (Neon)

1. Sign up at neon.tech and create a project. Pick the **Singapore**
   (ap-southeast-1) region — it's the closest to Mumbai.
2. Open **Connection Details** and copy the **Pooled connection** string.
   It has `-pooler` in the hostname. Use that one, not the direct string:
   Render opens and closes connections as it scales, and the pooler is what
   stops you exhausting the connection limit.
3. Keep it somewhere safe for step 3.

You don't need to create any tables. The app creates its own schema on first
boot and never overwrites data that already exists.

## 2. Push to GitHub

```bash
git init
git add .
git commit -m "Configurator and tender reader"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `uploads/`, `.env` and logs.
**Check before you push that no real API key is in any committed file** —
`.env.example` has placeholders only, which is what you want.

## 3. Deploy (Render)

1. Render dashboard → **New** → **Blueprint** → connect the repo.
   It reads `render.yaml` and fills most of this in.
2. Set the two secrets it can't guess:
   - `DATABASE_URL` — the Neon pooled string from step 1
   - `GEMINI_API_KEY` — from aistudio.google.com/apikey
   `ADMIN_TOKEN` is generated for you; copy it from the Environment tab
   afterwards, because your team needs it to open the admin pages.
3. Deploy. First build takes 2–3 minutes.
4. Open the URL and check `/health` — you want
   `{"ok":true,"ai":true,"provider":"gemini"}`.

### Why `plan: starter` and not free

A free Render service sleeps after 15 minutes of inactivity and takes about a
minute to wake. For a customer-facing configurator that's a bad first
impression, and for a tender upload it's a timeout. Starter is $7/month.
Change `plan: starter` to `plan: free` in `render.yaml` if you'd rather test
on free first — everything else works the same.

## 4. Load your catalog

The app boots with settings and the 22 tender extraction fields, but **no
parts**. That's deliberate — the old demo catalog would be worse than useless
against real tenders.

1. Admin → **Download Excel**. You get the exact sheet shape the importer
   expects, with the columns already correct.
2. Fill in Categories, Options and Rules. `cost` is your landed cost; the
   customer sees cost + margin and never the cost itself.
3. Upload it back. Nothing is deleted on import — rows are created or updated
   by `id`. To retire a part set `active = 0`.

Put real `lead_days` in. A zero there is read as "no lead time on record"
rather than "available immediately", and you'll get a wall of amber warnings
on every tender until it's filled in.

## Migrating your local SQLite data

If you entered anything into the Windows version worth keeping:

```bash
# on the machine with the old app
sqlite3 data/app.db ".mode csv" ".headers on" \
  ".once categories.csv" "SELECT * FROM categories;" \
  ".once options.csv"    "SELECT * FROM options;"
```

Then paste those into the Excel template and import. Going through the
importer rather than a direct SQL copy means the data gets validated on the
way in.

## Things that changed from the local version

- **Every database call is async.** If you edit the code, remember that
  `q.get`, `q.all` and `q.run` all return promises.
- **Settings are cached for 5 seconds** (`SETTINGS_CACHE_MS`). The rules
  engine reads them on nearly every request and the database is now a
  network hop away. Change it in Admin and it takes effect within 5 seconds.
- **Excel import runs in one transaction.** A malformed row rolls the whole
  workbook back rather than leaving half a price list applied.
- **The admin lockdown needs revisiting.** The current check treats any
  request carrying `x-forwarded-for` as external — correct behind a
  Cloudflare tunnel, wrong behind Render's proxy, where every request has
  that header. See below.

## Before you share the URL

On the office network a single shared token was defensible. On a public
Render URL, `/admin.html` and `/tender.html` face the internet with one
token, no rate limiting, no lockout and no audit trail. That token protects
every cost price and margin you have.

Two options, either is fine:

- **Restrict by IP** — allow only your office's public IP to reach the admin
  routes. Simple, and works well if the office IP is static.
- **Put real authentication in front** — per-user logins, so you can revoke
  one person without changing everyone's password.

Tell me which you'd prefer and I'll make the change. I'd rather do this
before the URL is circulated than after.
