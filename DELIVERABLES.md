# Campus Court — Deliverables

**CC by THE DARK TRIAD** · Sheikh Haroon, Turab & Ruwail
MVP v2.0.0 · plain Node.js + JSON DB + vanilla JS · one optional dep (`nodemailer`)

This document is the hand-off: what was built, what changed from the original
zip, how it is wired, how to run/configure it, what was actually tested (and what
was not), the Card 10 formula, and a demo script.

---

## 1. MVP feature list

### Preserved from the original project (working before, still working)
- Plain-Node HTTP server (no Express), static file serving, JSON-file persistence.
- AI judge with **key rotation**: Gemini → Groq → local fallback (60 s cooldown per bad key).
- Gmail summons via `nodemailer`, with console **dry-run** when unconfigured.
- Turn-based courtroom: complainant / accused mics, judge remarks, objections
  (sustained / overruled), verdict after 4 statements, default-on-no-show sweep.
- Community feed with likes; seeded demo students and cases.
- Roman-Urdu / Urdu / English aware judge prompt.

### New in this MVP
- **Cinematic intro (≈9.6 s)**: original SVG scenes (bullying → two advocates →
  judge + gavel strike) → CC logo → “CAMPUS COURT / CC by THE DARK TRIAD / Made by
  Sheikh Haroon, Turab and Ruwail”. Skip button; plays once (`localStorage`);
  short-circuits under `prefers-reduced-motion`. No copyrighted footage.
- **Real auth**: register (auto-approved) / login / logout / profile; scrypt
  password hashing; unique email + roll; server-side sessions (7-day TTL).
- **Admin dashboard** (role-gated): users, cases, invitations, moderation log,
  stats; ban / unban; temporary bans (24 h / 3 d / 7 d) + permanent, with reasons
  and auto-expiry; every action written to a moderation history.
- **Admin email notice** to `haroonsheik0127@gmail.com` on each new registration.
- **2-cases-per-day limit**, enforced server-side (not just UI).
- **Invitations**: (A) registered student → in-app invite + accept; (B) external
  email → cryptographically-secure expiring token link, hashed at rest,
  single-use, status-validated; invitee registers/logs in and joins the right case.
- **Mystery Card 10 — fair resource sharing**: resource dispute case type,
  urgency 1–10, deadline-derived need, per-resource fairness history, deterministic
  weighted scoring, explainable comparison table, proportional time-sharing,
  allocation history that feeds future decisions. AI commentary (if any) is
  labelled separately and never invents scores.
- **Premium frontend**: charcoal / ivory / muted-gold glassmorphism, controlled
  blue (plaintiff) & red (opposing), courtroom face-off with balance divider,
  responsive layouts, loading/empty/error/success states, hover + subtle 3D tilt,
  WebAudio gavel/tones, reduced-motion support.
- **Security hardening**: input validation, HTML escaping, path-traversal-safe
  static serving, body-size limit, admin-only routes, ban checks, no secrets or
  raw tokens in the frontend, role never self-assignable.
- **Tests**: 26 `node:test` cases (unit + hermetic HTTP integration).

---

## 2. Major changes vs the original zip

| Area | Before | After |
|---|---|---|
| Structure | one monolithic `server.js` | modular `lib/` (util, db, fairness, ai, mail, api) + thin `server.js` |
| Auth | name+roll+phone match, no passwords | email+password, scrypt hashes, sessions, register/profile/logout |
| Roles | none | `user` / `admin`; admin seeded; admin-only API routes |
| Moderation | none | ban/unban, temp bans + expiry, reasons, moderation log |
| Limits | none | 2 cases/day server-side |
| Invites | email link to case (no token) | secure expiring single-use tokens (registered + external) |
| Card 10 | absent | full deterministic fairness engine + UI |
| DB | schema-1 JSON | schema-2 JSON, atomic writes, forward migration preserving old data |
| Frontend | basic dark page | full design system, intro, all views, responsive, reduced-motion |
| Tests | none | 26 automated tests |
| Deps | nodemailer (vulnerable pin) | nodemailer upgraded to patched ^10.5.0 (0 audit findings) |

The original `data/db.json` (schema 1) is **migrated forward on first run** —
existing students and cases are preserved, passwords/roles/admin/collections added.

---

## 3. Architecture

### Backend
- `server.js` — loads `.env`, serves `public/` (path-traversal guarded), parses JSON
  bodies (400 bad JSON / 413 >1 MB), dispatches to `lib/api.handle`, exports
  `createServer()` for tests, auto-listens only when run directly.
- `lib/api.js` — route table + handlers; in-memory session Map; `sweep()` expires
  temp bans, overdue hearings and invitations; enforces auth/admin/ban/limits.
- `lib/db.js` — single JSON document; atomic save (temp file + rename); seed +
  migration; `publicUser()` strips `passwordHash` from every response.
- `lib/fairness.js` — **pure** Card 10 engine (no I/O, no AI): same inputs → same output.
- `lib/ai.js` / `lib/mail.js` — external services with graceful offline fallbacks.

### Frontend
- `public/index.html` — intro overlay, auth, app shell, invite landing, toast/modal.
- `public/styles.css` — design tokens (`--bg #14110e`, `--ivory #f4efe6`,
  `--gold #c9a24b`, `--blue #4a7bd0`, `--red #c0504d`), glass, responsive breakpoints,
  `prefers-reduced-motion` overrides.
- `public/app.js` — vanilla JS; `api()` fetch wrapper with Bearer token; view
  renderers (home/feed/file/mine/profile/admin/courtroom/resource/invite); polling
  for live cases; WebAudio + speech synthesis; no framework, no build step.

### Database (`data/db.json`, schema 2)
Collections: `students` (users incl. admin, `passwordHash`, `role`, `status`, `ban`),
`cases` (standard + resource), `resources` (name + allocation history),
`invitations` (tokenHash, status, expires), `moderation` (audit log).

---

## 4. API reference

Public: `POST /api/register`, `POST /api/login`, `GET /api/health`,
`GET /api/invitations/:id/preview`.

Authenticated (Bearer token): `POST /api/logout`, `GET /api/me`, `POST /api/profile`,
`GET /api/students`, `GET /api/feed`, `GET /api/mine`, `GET /api/courtrooms`,
`POST /api/cases` (standard, 2/day), `POST /api/resource` (Card 10),
`GET /api/cases/:id`, `POST /api/cases/:id/speak`, `.../objection`, `.../like`,
`.../claim` (resource need), `.../resolve` (owner/admin, runs Card 10),
`.../invite` (owner adds claimant), `POST /api/invitations/accept`.

Admin only: `GET /api/admin/users|cases|invitations|moderation|stats`,
`POST /api/admin/users/:id/ban`, `POST /api/admin/users/:id/unban`.

Purposes: auth/session; profile self-service (name/phone only — **role ignored**);
directory search; feed/mine/courtrooms listings; case filing + hearing turns +
objections + likes; resource claim/resolve (deterministic allocation); invitation
create/preview/accept; admin oversight + moderation.

---

## 5. Email integration (free tier)

- Provider: **Gmail SMTP** via `nodemailer` (free with a Google account).
- Configure `GMAIL_USER` + `GMAIL_APP_PASSWORD` (App Password, not login password).
- Two mails: **summons/invite** (secure link, expiry) and **admin notice** on
  registration (to `haroonsheik0127@gmail.com`).
- No credentials → console **dry-run**; in `DEMO=1` the invite link is also returned
  to the filer and shown in a modal so a single laptop can demo the whole flow.
- `DEMO_EMAIL` redirects all mail to one inbox for demos.
- Secrets stay server-side; the frontend only ever sees a rendered link, never keys.

## 6. AI integration (free tiers, optional)

`GEMINI_KEYS` / `GROQ_KEYS` (comma-separated) rotate; a failing key cools down 60 s.
Order: Gemini → Groq → local fallback judge. The AI writes **remarks/verdict prose
only**. Card 10 scores are **never** AI-generated; any AI advisory is shown in a
separate, clearly-labelled note.

---

## 7. Environment variables (all optional)

Set in `.env` next to `server.js` (copy `.env.example`). Full commented list there.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `BASE_URL` | `http://localhost:PORT` | origin used in invite links |
| `DEMO` | 1 | act-as switch + return dry-run links; 0 = production |
| `DEMO_EMAIL` | — | redirect all mail to one inbox |
| `CASE_HOURS` | 5 | appearance deadline |
| `INVITE_HOURS` | 48 | invitation token lifetime |
| `DB_FILE` | `data/db.json` | database path |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | — | Gmail SMTP |
| `GEMINI_KEYS` / `GROQ_KEYS` | — | rotating AI keys |
| `GEMINI_MODEL` / `GROQ_MODEL` | flash / llama-3.3-70b | model overrides |

---

## 8. Run / test commands

```bash
npm install
cp .env.example .env   # optional
npm start              # http://localhost:3000
npm run dev            # auto-reload
npm test               # 26 tests
```

VS Code: open this folder, Node ≥ 18, integrated terminal, `F5`/`npm run dev`.
Details in `README.md`.

---

## 9. Testing results & limitations

### Automated (all passing, re-verified): **26 / 26**
- Unit: scrypt hash verify/tamper, email validation, `dayKey`, constant-time compare,
  HTML escaping; Card 10 need buckets, history decay, weights, ranking, time-share
  largest-remainder, determinism.
- Integration (hermetic temp DB, real HTTP): register/login/duplicate-email/roll,
  admin self-promotion blocked, profile role ignored, ban + temp-ban expiry +
  unban, 2-case/day limit, standard hearing turns + objection + verdict + default,
  registered invite accept + reuse blocked, external invite token + expiry + reuse
  blocked, resource allocation + fairness history + later-claim resolve + owner-only
  resolve, static serving + path traversal blocked.

### Browser-verified (in-app browser, real DOM events + screenshots)
Intro scenes 1–3 + credits + skip; login (student & admin); logout; home hero +
stats + quick-grid + recent + courtrooms empty-state; feed cards; file-a-case →
courtroom; face-off blue/red + balance divider + countdown; speak (turn passes,
judge remark) + objection (sustained); Card 10 table (6 columns, winner highlight,
weights disclaimer, 75/62/43 min chips, plain-language explanation); admin tabs +
users + ban modal (24 h/3 d/7 d/perm + reason) → temp-ban → banned badge → unban →
moderation log; invite landing (title/inviter/expiry/auth buttons); profile; no
horizontal overflow at mobile width; console clean apart from two *expected* 401s
(a wrong-password attempt and a post-logout fetch).

### Limitations (honest)
- AI ran in **local-fallback** mode (no keys configured): judge prose is the
  deterministic fallback; the separate AI advisory note is correctly absent.
- Email ran in **dry-run** (no Gmail creds): links surfaced via DEMO modal/console,
  not actually delivered. Real delivery needs valid App Password.
- The in-app test browser exhibited an environment auto-clicker/autofill that caused
  stray navigations and one accidental registration into a **throwaway QA database**
  (since deleted). Not an application defect; shipped `data/db.json` is clean seed.
- Desktop-wide (>1000 px) layout not screenshot-captured (test viewport ≈630 px);
  desktop media queries exist, mobile/tablet verified visually.
- JSON-file DB is single-process; fine for a hackathon MVP, not for horizontal scale.
- Seeded demo passwords are public by design — change admin before real deployment.
- No claim of “100% error-free”: the above is what was actually exercised.

---

## 10. Mystery Card 10 — the formula (deterministic, auditable)

All terms on 1–10; **total = 0.40·urgency + 0.35·need + 0.25·fairness** (2 dp).

- **urgency** — student-provided 1–10, clamped.
- **need** — from hours-to-deadline: ≤6→10, ≤24→8, ≤48→6, ≤72→4, ≤168→2, else 1.
- **fairness** — `clamp(round(10 − 3·Σ(1 − ageH/168)), 1, 10)` over that student’s
  allocations of **this resource** in the last 7 days. Recent recipients score
  lower, so access rotates. Penalty decays linearly to 0 at 7 days.
- **Rank** — total desc; ties: urgency desc, deadline asc, roll asc.
- **Allocation** — exclusive (winner) OR, when time-divisible, split the window in
  proportion to totals (floor + largest-remainder to top ranks).
- **History** — every decided allocation is recorded per resource and feeds the
  fairness term of future disputes.
- **Explainability** — the UI shows the full table (Student, Urgency, Actual need,
  Fairness, Total, Decision), the weights, and a plain-language paragraph.
- **AI separation** — scores come only from this formula; any AI commentary is a
  separately-labelled advisory and cannot alter numbers.

Worked example (180 min window): Ayesha (u9,n8,f10)=8.9 → 75 min; Bilal (7,6,10)=7.4
→ 62 min; Sara (5,2,10)=5.2 → 43 min. Reproducible from the same inputs.

---

## 11. Hackathon demo script (≈4 min, one laptop)

1. **Intro** — clear `cc_intro_seen` (or first visit): watch bullying → advocates →
   gavel → logo/credits. Point out Skip + reduced-motion. (20 s)
2. **Register** a new student → toast “administrator notified”; show console
   dry-run admin email to haroonsheik0127@gmail.com. (30 s)
3. **Login** as `21cs014@example.com / court1234` → home hero + stats. (15 s)
4. **File a standard case** against a seeded student → summons toast → courtroom
   face-off (blue vs red, balance divider, countdown). Speak as plaintiff, switch
   act-as to accused, reply, **object**, reach verdict. (60 s)
5. **Card 10** — open “Who gets Lab Computer #3?” → explainable table + weights +
   75/62/43 time-share + plain-language reason. File a fresh resource dispute and
   resolve it live to show history affecting fairness. (60 s)
6. **External invite** — file with an external email → DEMO modal shows the secure
   link → open it logged-out → landing shows expiry → register → auto-join. (40 s)
7. **Admin** — login `haroonsheik0127@gmail.com` (password set via `ADMIN_PASSWORD`) → users → temp-ban 24 h
   with reason → banned badge → unban → moderation log. (30 s)
8. **Close** — feed likes, mobile resize, reduced-motion. (15 s)

---

## 12. Security notes

- Passwords: scrypt + per-user salt, constant-time verify; never returned by API.
- Sessions: random 16-byte tokens, 7-day expiry, server-side Map; logout deletes.
- Invitations: 24-byte random token, **SHA-256 hash at rest**, expiry + single-use +
  status checks; raw token only in the emailed link / DEMO modal.
- Authorization: admin routes check `role==='admin'` server-side; profile update
  ignores `role`; ban checks on every authenticated action; 2/day limit server-side.
- Output: HTML-escaped everywhere; static path traversal blocked; 1 MB body cap.
- Secrets: only in `.env` on the server; frontend never receives keys or hashes.
- **Before production**: change seeded admin password, set `DEMO=0`, set `BASE_URL`,
  add real Gmail/AI keys, and put the JSON DB behind a real datastore if scaling.
- We do **not** claim IP/device checks guarantee one-human-one-account; uniqueness
  is enforced by email/roll only.