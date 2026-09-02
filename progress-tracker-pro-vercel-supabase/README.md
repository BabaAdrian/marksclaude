# Progress Tracker Pro

An AIRADS marks register, coursework/mock exam entry, and PDF transcript & progress
report generator — now backed by a real database instead of the browser's local storage.

This project was built with [Lovable](https://lovable.dev).

## What's new in this update

- **Backend database.** All data (classes, units, students, marks, mock scores, teacher
  accounts, institution letterhead) is now stored in [Supabase](https://supabase.com)
  Postgres instead of the browser's localStorage, via [Drizzle ORM](https://orm.drizzle.team).
  See **Deploying to Netlify + Supabase** below for exact steps.
- **Common units.** When adding a unit, you can now mark it "Common unit — taught across
  several courses". Common units show a badge everywhere they appear.
- **Admission-number lookup.** On the Marks Entry screen, teachers can search for any
  student by admission number — across the whole institute, not just their own classes —
  and jump straight into that student's record to enter marks for a common unit, without
  first picking a class.
- **Hashed passwords.** Admin and teacher passwords are hashed before storage and never
  sent to the browser — see **Passwords** below.

## Deploying to Vercel + Supabase

Two accounts, both free to start: [supabase.com](https://supabase.com) and
[vercel.com](https://vercel.com). Total time: about 10 minutes.

### 1. Create the Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Pick an organization, name the project (e.g. `progress-tracker-pro`), set a
   database password — **save this password somewhere**, you'll need it in step 3 —
   choose the region closest to your users, and click **Create new project**. It takes
   a minute or two to provision.

### 2. Get the connection string

1. Once the project is ready: **Project Settings** (gear icon, bottom of the left
   sidebar) → **Database**.
2. Under **Connection string**, select the **Transaction pooler** tab (this is the one
   that works from serverless functions like Vercel's — the direct connection does not,
   because serverless functions open a fresh connection per request and Postgres can't
   handle enough of those directly).
3. Copy the URI. It looks like:
   ```
   postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-xx-xxxx-1.pooler.supabase.com:6543/postgres
   ```
4. Replace `[YOUR-PASSWORD]` with the database password from step 1.

You now have your `DATABASE_URL`. Nothing else to set up on the Supabase side — no
tables to create by hand, no SQL to run. The app creates its own tables and loads the
starting dataset automatically the first time it connects to the empty database.

### 3. Push the code to a Git repository

Vercel deploys from a Git repo (GitHub, GitLab, or Bitbucket). If this project isn't
already in one:

```sh
cd progress-tracker-pro-main
git init
git add .
git commit -m "Add Supabase backend, common units, admission-number search"
```

Create an empty repository on GitHub (or your provider of choice), then:

```sh
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

### 4. Connect the repo to Vercel

1. [vercel.com/new](https://vercel.com/new) → import this repository.
2. On the configuration screen, set **Framework Preset** to **Other** (the repo's
   `vercel.json` already pins the build command, but selecting "Other" stops Vercel
   guessing "Vite" and assuming a plain static site — this app needs its server
   function, not just static assets).
3. Open **Environment Variables** and add:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the connection string from step 2 |
4. Click **Deploy**.

The build produces a Node.js serverless function (not an Edge function) — that matters
because it's what lets the app hold a normal TCP connection to Postgres; `vercel.json`
and `vite.config.ts` are already set up for this, nothing to change.

### 5. Verify

Once the deploy finishes, open the URL Vercel gives you. The first page load will take
an extra second or two the very first time — that's the app creating its tables and
loading the starting dataset into your new Supabase project. After that it's instant.
Log in with the default admin account (`admin` / `admin123`) and change the password
immediately from **Admin Password** in the admin dashboard.

### Local development

Same `DATABASE_URL` variable, just set locally instead of in Vercel. Either point it at
the same Supabase project, or create a second free Supabase project to use as a dev
database so you're not testing against live student data:

```sh
cp .env.example .env
# edit .env and paste your DATABASE_URL
bun install
bun run dev
```

### Redeploying after further changes

Push to the connected branch — Vercel rebuilds automatically. No database migration
step to run; new tables or columns you add to `src/db/schema.ts` need a matching change
to the `CREATE TABLE IF NOT EXISTS` statements in `src/db/client.ts`'s `ensureSchema()`
(the two are kept in sync by hand rather than via a separate migration runner, to keep
"one connection string and it just works" true for deploys).

### Passwords

Admin and teacher passwords are hashed (bcrypt) before they ever touch the database —
neither the admin password nor any teacher's password is stored in plain text, and none
of them are ever sent to the browser, not even to the admin's own Staff page. The
tradeoff: the admin can no longer *see* an existing password, only set a new one. From
**HODs & Teachers**, use **Set password** on a brand-new account or **Reset password**
on an existing one; from **Admin Password**, changing the admin password requires the
current one, verified server-side.

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ebca8226-48c8-4c1b-a54b-d1c62a3e2a07).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

