# Meeting Coach

AI-powered post-meeting scorecards. Pulls transcripts from Fathom, scores them with Claude using role-specific coaching prompts, emails the scorecard via Resend, archives to GitHub, and emits a weekly rollup every Monday at 7 AM ET.

Multi-tenant: every user gets their own webhook URL and role-specific scoring (sales rep, sales manager, executive, marketing).

---

## Architecture

```
Fathom ──► (webhook OR poll) ──► server.js
                                      │
                                      ├─► Claude (Haiku 4.5)  ──► JSON scorecard
                                      │
                                      ├─► Resend  ──► HTML coaching email
                                      │
                                      └─► GitHub archive  ──► <user>/<date>_<title>.md

Cron (Mon 7am ET) ──► rollup.js ──► reads last 7d from archive ──► Claude rollup ──► email + <user>/weekly/<date>.md
```

### Two ingestion paths
- **Polling** (`pollFathom`): every 2 min hits `GET /external/v1/meetings?include_transcript=true&created_after=<24h ago>`
- **Webhooks**:
  - `POST /webhook` — Gil's original endpoint, hardcoded to executive prompt
  - `POST /webhook/:webhookId` — multi-tenant; webhook ID resolves to a user record

### Scoring
- Transcript trimmed to 50K chars, sent to `claude-haiku-4-5-20251001` with the user's role-specific prompt
- Response is parsed as JSON (no markdown fences)
- If parsing fails, a fallback scorecard is sent so the user still gets an email

### Archive
GitHub PUT to `gwels90/meeting-coach-archive` (or whatever `GITHUB_ARCHIVE_REPO` is set to). Fail-soft — never blocks the email flow.

---

## File Map

| File | Purpose |
|------|---------|
| `server.js` | Express app — webhooks, polling, cron, setup wizard HTML, admin dashboard HTML |
| `prompt.js` | Original hardcoded executive prompt (Gil's `/webhook` flow) |
| `prompts.js` | Role dimensions + `getPromptForUser()` — substitutes `{name}` and `{custom_context}` |
| `prompts-db.js` | JSON store (`.prompts.json`) for editable per-role prompts. Seeds 4 defaults on first boot |
| `db.js` | JSON user store (`.users.json`) — id, name, email, role, webhook_id (uuid), custom_context, active |
| `email-template.js` | `buildEmail(scorecard)` + `getSubjectLine(scorecard)` — HTML email |
| `archive.js` | GitHub Contents API. `saveMeeting`, `listUserMeetings`, `saveRollup` |
| `rollup.js` | Weekly aggregation + role-specific rollup prompt + email + archive write |
| `.env.example` | Required env vars |
| `meeting-coach.db` | Legacy SQLite — replaced by JSON for Railway compat. Safe to ignore |

---

## Roles & Scoring Dimensions

All four prompts are editable live from `/admin`. Defaults live in `prompts-db.js`.

| Role | Dimensions |
|------|------------|
| `executive` | strategic_clarity, time_discipline, decision_quality, delegation_execution, coaching_development, energy_presence, meeting_necessity |
| `sales_rep` | discovery_quality, objection_handling, value_communication, pipeline_discipline, next_steps_followup, professionalism_tone, product_knowledge |
| `sales_manager` | coaching_quality, accountability, meeting_structure, time_management, blocker_resolution, team_energy, professionalism_tone |
| `marketing` | strategic_alignment, data_driven_thinking, creative_quality, cross_team_collaboration, prioritization, accountability, channel_expertise |

Every prompt outputs the same shape:
```json
{
  "meeting_summary": "...",
  "meeting_type": "standup | strategy | 1on1 | vendor | sales | ops | other",
  "duration_assessment": "too short | appropriate | too long",
  "scores": { "<dimension>": { "score": 1-10, "rationale": "..." }, ... },
  "overall_score": 1-10,
  "overall_grade": "A+ ... F",
  "delegation_flags": [{ "task", "why_flag", "suggested_owner", "handoff_script" }],
  "top_3_wins": ["..."],
  "top_3_improvements": ["..."],
  "one_liner": "..."
}
```

Prompt placeholders:
- `{transcript}` — required, populated at scoring time
- `{name}` — user's full name
- `{custom_context}` — wrapped block from the user's setup wizard

---

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/` | — | Status JSON (mode, processed count, registered users) |
| GET | `/health` | — | `{status:"ok"}` |
| POST | `/webhook` | HMAC | Gil's original Fathom webhook (executive prompt, hardcoded) |
| POST | `/webhook/:webhookId` | HMAC | Multi-tenant — webhook_id resolves to a user |
| GET | `/setup` | — | 5-step user setup wizard (HTML) |
| GET | `/admin` | password | Admin dashboard (HTML, password-gated client-side) |
| POST | `/api/users` | — | Create user — returns `{id, webhook_url, ...}` |
| GET | `/api/users` | admin | List users |
| PUT | `/api/users/:id/toggle` | admin | Flip active/inactive |
| GET | `/api/prompts` | admin | List all 4 role prompts |
| GET | `/api/prompts/:role` | admin | One prompt |
| POST | `/api/prompts/:role` | admin | Update prompt text |
| POST | `/api/prompts/:role/reset` | admin | Reset to hardcoded default |
| POST | `/rollup/all` | admin | Trigger weekly rollup for all active users |
| POST | `/rollup/:userId` | admin | Trigger rollup for one user |
| POST | `/poll` | — | Trigger Fathom poll now |
| POST | `/test` | — | Send a sample coaching email |
| POST | `/reset` | — | Clear processed-meetings list |

Admin auth = `X-Admin-Password` header or `?password=` query, checked against `ADMIN_PASSWORD`.

Webhook signature: HMAC-SHA256 of raw body, hex-encoded, compared with timing-safe equal. Header tried in order: `x-fathom-signature`, `x-webhook-signature`, `x-signature`, `x-hook-secret`. If `FATHOM_WEBHOOK_SECRET` is unset, verification is skipped.

---

## Environment Variables

```
# Fathom
FATHOM_API_KEY=...
FATHOM_WEBHOOK_SECRET=whsec_...

# Claude
ANTHROPIC_API_KEY=sk-ant-...

# Resend
RESEND_API_KEY=re_...
EMAIL_TO=gilbert@valveman.com
EMAIL_FROM=Meeting Coach <onboarding@resend.dev>

# Admin
ADMIN_PASSWORD=...

# Polling
POLL_INTERVAL_MS=120000   # default 2 min

# Server
PORT=3000

# GitHub archive (fine-grained PAT, Contents: Read/Write on archive repo only)
GITHUB_TOKEN=github_pat_...
GITHUB_ARCHIVE_REPO=gwels90/meeting-coach-archive
```

Required: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`. Server exits on boot without them.
Optional: `FATHOM_API_KEY` (without it, polling is disabled but webhooks still work). `GITHUB_TOKEN` + `GITHUB_ARCHIVE_REPO` (without them, archive + weekly rollup are silently skipped).

---

## Run Locally

```bash
npm install
cp .env.example .env   # fill in real values
npm start              # or: npm run dev  (uses node --watch)
```

Open:
- `http://localhost:3000/setup` — create a user, get a webhook URL
- `http://localhost:3000/admin` — manage users, edit prompts (needs `ADMIN_PASSWORD`)

Quick smoke test:
```bash
curl -X POST http://localhost:3000/test
```
Sends a sample coaching email built from a hardcoded transcript.

---

## Deployment (Railway)

The code has Railway-specific accommodations:
- Binds to `0.0.0.0` (line ~746)
- Process-level `uncaughtException` / `unhandledRejection` handlers so the process isn't silently killed
- 10s delay before the initial Fathom poll (lets Railway's proxy connect first)
- `setInterval` heartbeat every 30s to confirm liveness in logs
- JSON file DB instead of native `better-sqlite3` (no native deps to compile)

State files (created at runtime; ignored by git):
- `.users.json` — user records
- `.prompts.json` — editable prompts
- `.processed-meetings.json` — dedupe set keyed by meeting ID (or `<userId>:<meetingId>` for multi-tenant)

---

## Setup Wizard Flow (`/setup`)

1. Welcome screen
2. Name + email
3. Role picker (4 cards)
4. Optional custom context (free-text — direct reports, current goals, etc.)
5. Confirmation — shows the user's unique `webhook_url`. They paste this into Fathom → Settings → Integrations → Webhooks.

---

## Admin Dashboard (`/admin`)

- Stats: total users, active count, total meetings processed, distinct roles
- Users table: name, email, role badge, webhook URL (click to copy), meeting count, created date, active toggle
- **Prompt editor**: 4 tabs (one per role), monospace textarea, live placeholder detector (warns if `{transcript}` is missing), Save / Reset-to-default buttons. Edits take effect for the next meeting.

---

## Weekly Rollup

Cron loop (1-min tick): on Monday at 7:00 AM ET, runs `rollup.runRollupForAll` for every active user.

Per user:
1. List meeting markdown files in `<user-slug>/` from the archive repo for the last 7 days
2. Strip transcripts (cheap prompt) — keep just scorecards
3. Send to Claude with the role-specific rollup prompt
4. Email to user **and** Gil
5. Write `<user-slug>/weekly/<YYYY-MM-DD>.md` to the archive

Rollup output shape:
```json
{
  "week_summary": "...",
  "meetings_reviewed": 5,
  "avg_score": 7.2,
  "trend": "improving | steady | declining",
  "top_strengths": ["..."],
  "top_coaching_priorities": [{ "area", "pattern", "action" }],
  "one_thing_this_week": "...",
  "manager_flag": "..."   // or "delegation_theme" for executives
}
```

Manual trigger: `POST /rollup/all?days=7` (admin) or `POST /rollup/:userId?days=14` for a custom window.

---

## Known Quirks

- `package.json` description still says "via Fathom + Claude + Gmail" — actually Resend.
- `meeting-coach.db` is a SQLite leftover from before the JSON migration; nothing reads it.
- The legacy `/webhook` endpoint hardcodes Gil's name + email + role on archive writes. Multi-tenant `/webhook/:webhookId` should be preferred for new users.
- The 50K-char transcript truncation is a hard cap — long meetings get tail-truncated with a marker line. Watch for this on day-long workshops.
- Webhook signature verification accepts any of 4 header names — Fathom has changed them over time.
