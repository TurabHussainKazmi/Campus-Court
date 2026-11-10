# ⚖️ Campus Court

A dignified, fair mock-court for campus disputes — with an AI judge and **Card 10
fair-resource sharing** (deterministic, explainable allocation, never
first-come-first-served).

**CC by THE DARK TRIAD** · Made by Sheikh Haroon, Turab and Ruwail.

Plain Node.js (no web framework), a JSON-file database, and a vanilla-JS
frontend. One optional dependency (`nodemailer`) for Gmail invites. No build
step, no paid services required.

---

## Quick start

```bash
npm install          # installs nodemailer (only dependency)
cp .env.example .env # optional: add Gmail / Gemini / Groq keys
npm start            # → http://localhost:3000
```

With an **empty `.env`** everything still works offline:
the judge uses a local fallback, email prints dry-run links to the console,
and demo mode lets you act as both parties on one laptop.

### Demo accounts (seeded automatically)

| Role    | Email                        | Password   |
|---------|------------------------------|------------|
| Admin   | `haroonsheik0127@gmail.com`  | `admin1234`|
| Student | `21cs014@example.com`        | `court1234`|

Other seeded students use `court1234` with their `@example.com` email
(`21cs027@`, `22ee009@`, `22se033@`, `21me045@`, `23bba12@`, `22cs051@`).
New registrations are auto-approved and pick their own password.

> Change the seeded admin password before any real deployment (see
> `DELIVERABLES.md` → Security notes).

---

## VS Code setup

1. **Open the folder**: `File → Open Folder…` → select this `DARK_TRIAD` directory.
2. **Install Node.js ≥ 18** (https://nodejs.org). Verify: `node -v`.
3. Recommended extensions (optional): *ESLint*, *Prettier*, *REST Client*.
4. Open the integrated terminal (`` Ctrl+` ``) and run the Quick start commands.
5. Run / debug: press `F5` with a Node launch config, or just `npm run dev`
   (auto-restarts on file changes via `node --watch`).
6. Browse to http://localhost:3000.

No compiler, bundler, or TypeScript step — `public/` is served as-is.

---

## Commands

| Command             | What it does                                        |
|---------------------|-----------------------------------------------------|
| `npm start`         | Run the server (`node server.js`)                   |
| `npm run dev`       | Run with auto-reload (`node --watch server.js`)     |
| `npm test`          | Run all 26 backend tests (`node --test`)            |
| `npm run test:spec` | Same tests, verbose spec reporter                   |

---

## What's inside

```
server.js            HTTP server: static files + API dispatch + .env loader
lib/
  util.js            hashing (scrypt), tokens, validation, escaping
  db.js              JSON DB: atomic saves, seed, forward migration, publicUser
  fairness.js        Card 10 deterministic scoring + time-sharing engine
  ai.js              Gemini → Groq → local-fallback judge (key rotation)
  mail.js            Gmail invites + admin notices (dry-run fallback)
  api.js             all route handlers + auth/session/ban/limit enforcement
public/
  index.html         intro, auth, app shell, invite landing
  styles.css         charcoal/ivory/gold design system, responsive, reduced-motion
  app.js             vanilla-JS client (all views, courtroom, admin, Card 10)
  cc-logo.svg        original CC roundel
test/                node:test suites (unit + hermetic HTTP integration)
data/db.json         auto-created seed database (schema 2)
```

See **`DELIVERABLES.md`** for the full feature list, architecture, API reference,
email/AI integration notes, testing results + limitations, the Card 10 formula,
and a hackathon demo script.