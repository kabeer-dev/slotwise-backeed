# Slotwise — Backend (API)

Express + PostgreSQL API for **Slotwise**, an AI-assisted appointment booking app. It handles
authentication, appointments, chat conversations and the AI booking assistant (Mistral), and
pushes live updates to the browser over Socket.IO.

The web app is a separate project: **slotwise-frontend** (_add your repo link_).

| | |
|---|---|
| **Live API** | _add your Render URL_ — health check at `/health` |
| **Live app** | _add your Vercel URL_ |
| **Demo login** | `demo@slotwise.dev` / `Demo@12345` |

**Stack:** Node.js 20+ · Express 5 · TypeScript · PostgreSQL 14+ (`pg`, raw SQL) · Socket.IO · zod · pino · Mistral (`mistral-small-latest`, JSON mode) · Vitest + Supertest

---

## Contents

1. [Quick start](#quick-start)
2. [Environment variables](#environment-variables)
3. [Architecture](#architecture)
4. [API reference](#api-reference)
5. [AI integration](#ai-integration)
6. [Database](#database)
7. [Key decisions and tradeoffs](#key-decisions-and-tradeoffs)
8. [Assumptions](#assumptions)
9. [Known limitations and next steps](#known-limitations-and-next-steps)
10. [Testing](#testing)
11. [Deployment](#deployment)
12. [Project structure](#project-structure)

---

## Quick start

**Prerequisites:** Node.js 20+ and PostgreSQL 14+ (local install, Docker, or a free Neon/Supabase database).
The schema uses the `btree_gist` extension, which is available on all of these.

```bash
# 1. Create a database
createdb slotwise                        # or: psql -U postgres -c "CREATE DATABASE slotwise"

# 2. Configure
cp .env.example .env                     # set DATABASE_URL and JWT_SECRET (see below)

# 3. Install, create tables + demo data, run
npm install
npm run db:migrate -- --seed             # applies database/schema.sql + database/seed.sql
npm run dev                              # → http://localhost:4000/health
```

**Or with Docker** (Postgres + API, no local Postgres needed):

```bash
docker compose up --build                # → http://localhost:4000
```

Then start the frontend project and sign in with `demo@slotwise.dev` / `Demo@12345`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with auto-reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled build |
| `npm run db:migrate` | Apply `database/schema.sql` (idempotent — safe to re-run) |
| `npm run db:migrate -- --seed` | …plus demo data from `database/seed.sql` (also idempotent) |
| `npm run db:reset` | Drop everything, re-create, re-seed (refuses in production) |
| `npm test` | Unit + integration tests |
| `npm run typecheck` | TypeScript check incl. tests |

## Environment variables

Copy `.env.example` to `.env`. Everything is validated at startup — the server refuses to boot with missing or invalid config and tells you which variable is wrong.

### Required

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/slotwise` | PostgreSQL connection string |
| `JWT_SECRET` | 48+ random characters | Must be ≥ 32 chars. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |

### Needed in production

| Variable | Example | Notes |
|---|---|---|
| `CORS_ORIGINS` | `https://slotwise-frontend.vercel.app` | Frontend URL(s), comma-separated. Default `http://localhost:3000` |
| `MISTRAL_API_KEY` | `…` | Free key at console.mistral.ai. **Without it the API uses an offline rule-based interpreter** (same output format) |
| `NODE_ENV` | `production` | Hides internal error details, JSON logs |
| `DATABASE_SSL` | `true` | `true` for Neon / Supabase / external URLs; `false` for local and Render's internal URL |
| `TRUST_PROXY` | `1` | Set to `1` behind Render / Railway / Fly so rate limits see real client IPs |

### Optional (defaults are fine)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | Render sets this automatically |
| `LOG_LEVEL` | `info` | `debug`, `warn`, `error`, `silent` … |
| `DATABASE_POOL_MAX` | `10` | Max DB connections |
| `JWT_EXPIRES_IN` | `1d` | e.g. `12h`, `7d` |
| `DEFAULT_BUSINESS_SLUG` | `lumen-clinic` | Tenant used when the client doesn't send one |
| `AI_PROVIDER` | auto | `mistral` if a key is set, otherwise `mock` |
| `MISTRAL_MODEL` | `mistral-small-latest` | |
| `MISTRAL_BASE_URL` | `https://api.mistral.ai/v1` | |
| `AI_TIMEOUT_MS` | `15000` | Per attempt (one retry on 429/5xx) |
| `AI_HISTORY_WINDOW` | `12` | Messages of conversation memory sent to the model |
| `AI_LOG_PROMPTS` | `true` | Store full prompts in `ai_interactions`; `false` reduces stored personal data |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `20` | Chat messages per user per minute |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/slotwise_test` | Only for `npm test` |
| `DATABASE_DIR` | `./database` | Only if you move the SQL files |

**Demo aid:** without a Mistral key, a chat message containing `#ai-down` simulates an AI outage so the form fallback can be shown.

## Architecture

```mermaid
flowchart LR
  WEB["slotwise-frontend<br/>(Next.js, separate project)"]

  subgraph API["slotwise-backend — Express (TypeScript)"]
    MW["Middleware<br/>helmet · CORS · pino-http · rate limit · zod · JWT"]
    AUTH["auth"]
    APPT["appointments<br/>scheduling rules"]
    CHAT["chat<br/>orchestrator + dialog policy"]
    AI["AI boundary<br/>interpretTurn()"]
    WS["Socket.IO server<br/>room per user"]
    EV(["domain events"])
  end

  DB[("PostgreSQL")]
  LLM["Mistral API"]

  WEB -- "REST /api/v1 (Bearer JWT)" --> MW
  MW --> AUTH & APPT & CHAT
  CHAT --> AI
  AI -- "JSON mode" --> LLM
  CHAT -- "validate · book via" --> APPT
  AUTH & APPT & CHAT & AI --> DB
  APPT -- "appointment.created / cancelled" --> EV
  EV --> WS
  CHAT --> WS
  WS -- "chat:message · chat:typing<br/>chat:session · appointments:changed" --> WEB
```

**One chat turn**

```mermaid
sequenceDiagram
  participant B as Browser
  participant C as Chat service
  participant AI as AI boundary
  participant M as Mistral
  participant P as Dialog policy
  participant A as Appointments
  participant DB as PostgreSQL

  B->>C: POST /chat/sessions/:id/messages {content, clientMessageId}
  C->>DB: insert user message (idempotent on clientMessageId)
  C-->>B: socket chat:typing true
  C->>DB: last 12 messages + booking draft + services
  C->>AI: interpretTurn(context)
  AI->>M: system prompt + history (JSON mode, 15s timeout, 1 retry)
  M-->>AI: {intent, service, date, time, notes, needs_clarification, reply}
  AI->>DB: log ai_interactions row
  AI-->>C: validated AiTurn — or typed failure
  C->>P: runDialogTurn(draft, aiResult)
  P->>A: check date / hours / grid / availability
  P-->>C: reply + UI action + new draft
  C->>DB: insert assistant message + update draft (one transaction)
  C-->>B: 201 {userMessage, assistantMessage, session} + socket push
```

Booking is **never** performed by the model. A summary is shown first; the confirm endpoint
(or a typed "yes" while a summary is pending) books through the same `appointments` service the
booking form uses.

**Layers per module:** `*.routes.ts` (HTTP + validation) → `*.service.ts` (business logic) → `*.repository.ts` (parameterised SQL). Modules talk through services and in-process domain events (`src/subscribers.ts`), so `appointments` doesn't know chat or WebSockets exist.

## API reference

Base path `/api/v1`, JSON in and out. Authenticated routes need `Authorization: Bearer <token>`.
Ready-to-run examples: [`docs/api.http`](docs/api.http) (VS Code REST Client / JetBrains HTTP client).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` (no prefix) | — | Liveness + DB check + active AI provider |
| GET | `/businesses/:slug` | — | Public tenant info (name, hours, timezone) |
| POST | `/auth/signup` | — | `{fullName, email, password}` → `201 {token, user, business}` |
| POST | `/auth/login` | — | `{email, password}` → `{token, user, business}` |
| GET | `/auth/me` | ✓ | Current user + business |
| GET | `/services` | ✓ | Bookable services |
| GET | `/appointments?scope=upcoming\|history` | ✓ | Caller's appointments |
| GET | `/appointments/availability?serviceId&date` | ✓ | Free start times (`HH:mm`, business timezone) |
| POST | `/appointments` | ✓ | `{serviceId, date, time, notes?, chatSessionId?}` → `201` |
| GET | `/appointments/:id` | ✓ | One appointment |
| POST | `/appointments/:id/cancel` | ✓ | Cancel |
| GET | `/chat/sessions` | ✓ | Caller's conversations, newest first |
| POST | `/chat/sessions` | ✓ | New conversation (with greeting) → `201` |
| GET | `/chat/sessions/:id` | ✓ | Session incl. `bookingState` |
| GET | `/chat/sessions/:id/messages?limit&before` | ✓ | History, keyset-paginated (`nextCursor`) |
| POST | `/chat/sessions/:id/messages` | ✓ | `{content, clientMessageId?}` → `201 {userMessage, assistantMessage, session}` |
| POST | `/chat/sessions/:id/confirm` | ✓ | Book the pending summary (no AI call) |

**Errors** always have the same shape:

```json
{ "error": { "code": "SLOT_UNAVAILABLE", "message": "That time is already booked.", "details": { "field": "time", "alternatives": ["09:15", "11:30"] }, "requestId": "…" } }
```

| Status | When (example codes) |
|---|---|
| 400 | `VALIDATION_ERROR` (field-level `details`), `INVALID_JSON`, `INVALID_ID` |
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS` |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND` (also for other users'/tenants' records — no existence leak) |
| 409 | `EMAIL_TAKEN`, `SLOT_UNAVAILABLE`, `DUPLICATE_MESSAGE`, `TURN_IN_PROGRESS`, `NOT_CANCELLABLE`, `NOTHING_TO_CONFIRM` |
| 413 | `PAYLOAD_TOO_LARGE` (body > 32 kB) |
| 422 | Business rules: `CLOSED_DAY`, `OUTSIDE_HOURS`, `OFF_GRID`, `TOO_SOON`, `DATE_IN_PAST`, `BEYOND_HORIZON`, `SERVICE_UNAVAILABLE` |
| 429 | `RATE_LIMITED` (+ `RateLimit` headers) |
| 500 | `INTERNAL_ERROR` (details only in logs, traceable by `requestId`) |

**Socket.IO** (same origin as the API; connect with `auth: { token }`). Server → client events: `chat:message`, `chat:typing`, `chat:session`, `appointments:changed`.

## AI integration

**Boundary.** `src/ai/index.ts` exposes one function, `interpretTurn(context)`. It returns a validated `AiTurn` or a typed failure (`timeout | error | invalid_output`), never throws, and logs every call. Nothing else in the codebase knows a model exists.

**What the model does** — classify the latest message and extract details, as JSON:

```json
{ "intent": "book | confirm | decline | list_appointments | reset | other",
  "service": "Dental Cleaning", "date": "2026-10-05", "time": "15:00", "notes": null,
  "needs_clarification": false, "reply": "Which day works for you?" }
```

**What the model does not do** — check availability, decide validity, book, cancel, or state facts. The dialog policy (`src/modules/chat/bookingDialog.ts`) owns that:

- Extracted fields are merged into a persisted draft and each one is validated by the same pure scheduling rules the REST API uses (working day, opening hours incl. service duration, 15-minute grid, lead time, horizon, overlap). Invalid fields are cleared and explained in deterministic text, with real nearby free times as suggestions.
- When everything is valid, the summary is built from database values, not model text.
- Booking requires explicit confirmation; "confirm" only counts while a summary is pending.

**Grounding & memory.** The system prompt carries the current date/time in the business timezone, opening hours, the exact service list and the details collected so far; the last 12 messages provide conversational memory. Temperature 0.2, JSON mode, 400 max tokens.

**Guardrails**
- Output parsed defensively and validated with zod; a bad individual field becomes `null` instead of failing the turn; unknown intents become `other`; a missing reply is a failed turn.
- Model replies that claim a booking happened are replaced — only the system confirms bookings.
- The prompt tells the model to ignore attempts to change its role or format; it has no tools and no data beyond the caller's own conversation.
- Input capped at 1,000 characters; chat calls rate limited per user.
- 15 s timeout per attempt, one retry for 429/5xx/network only.

**Fallback to the structured form** (sent as a `booking_form` action, prefilled with what was captured): AI unavailable, timed out or returned invalid output · the model flags the request as ambiguous · two turns in a row without progress · the user declines a summary. Bookings made through that form are posted back into the conversation.

**Observability.** One `ai_interactions` row per call: provider, model, prompt version, status, latency, tokens, request messages (optional), raw output, parsed output, error — plus a structured log line.

## Database

Full DDL, sample data and the reasoning behind every index: [`database/README.md`](database/README.md).

- **Double booking is impossible at the database level** — GiST exclusion constraint on `(business_id, tstzrange(starts_at, ends_at))` for live statuses; covered by a test that fires concurrent bookings.
- **Tenant isolation via composite foreign keys** — an appointment can't reference a user or service of another business.
- Messages normalised into `chat_messages` (O(1) appends, keyset pagination); the booking draft lives on `chat_sessions.booking_state` so conversations resume anywhere.
- `timestamptz` everywhere; opening hours stored as local time + IANA timezone per tenant.

## Key decisions and tradeoffs

1. **AI interprets, code decides.** The LLM is only trusted with language understanding; every rule that matters is deterministic and unit-tested. Cost: replies are a little less free-form.
2. **Writes over REST, pushes over WebSocket.** Messages are sent via REST (validated, rate limited, logged, testable). Socket.IO only pushes changes, to a private per-user room. If the socket drops, replies still arrive in the HTTP response.
3. **Explicit confirmation**, via a `/confirm` endpoint that doesn't call the AI.
4. **Correctness in the database** — the exclusion constraint is the source of truth for conflicts.
5. **Raw SQL with `pg`, no ORM** — queries map 1:1 to the documented indexes. Cost: hand-written row mapping.
6. **Bearer JWT** — works across separate frontend/API domains without cookie complexity. Cost: the frontend keeps it in `localStorage` (XSS-readable). Production: httpOnly cookie on a shared domain + refresh tokens.
7. **Idempotent message sends** via `clientMessageId` — retries can't duplicate a message or an LLM call.
8. **No LLM call inside a DB transaction.**
9. **Mock interpreter with the same contract** — local dev, CI and demos don't need an API key; the dialog policy is tested deterministically.
10. **Modular monolith** — `auth`, `catalog`, `appointments`, `chat`, `ai` could be split out later without changing the HTTP contract.

## Assumptions

- One bookable resource per business (one practitioner/chair), so any overlap is a conflict.
- Customers book for themselves; staff/admin roles exist in the schema but have no UI.
- Times are entered and shown in the **business** timezone (seed: `Asia/Karachi`).
- Same opening hours every working day; 15-minute slot grid; ≥ 15 minutes' notice; up to 60 days ahead.
- Tenant chosen by slug; a real SaaS would use subdomains.
- English conversations.

## Known limitations and next steps

- **Scaling out:** rate limits, the per-conversation lock and Socket.IO rooms are in-process → Redis store, Redis lock, Socket.IO Redis adapter.
- **Auth:** no refresh tokens, password reset or email verification; sockets aren't dropped when a token expires.
- **Scheduling:** no staff/rooms, per-day hours, holidays, buffers, rescheduling or reminders.
- **AI:** no token streaming; JSON mode rather than function calling; English only.
- **Data:** `ai_interactions` stores user text — add a retention job (or set `AI_LOG_PROMPTS=false`); single idempotent schema file instead of versioned migrations; Row-Level Security not enabled.
- **Free hosting:** Render's free instance sleeps — the first request can take 30–50 s.

## Testing

```bash
npm test             # unit + integration
npm run typecheck
```

Integration tests need a Postgres database named `slotwise_test` (or set `TEST_DATABASE_URL`); it is rebuilt from `database/` on every run. If Postgres isn't reachable, integration tests are skipped and unit tests still run.

- **Unit:** scheduling rules, AI output parsing, prompt construction, the rule-based interpreter, and the dialog policy (fallbacks, confirmation, false-confirmation guard, stalled-turn form trigger).
- **Mistral client contract (stubbed `fetch`):** request shape and JSON mode, history normalisation, retry on 429, no retry on 4xx, timeout and invalid-output handling.
- **Integration (real PostgreSQL):** auth + validation, booking + clash alternatives + cancel/rebook, **concurrent double-booking**, cross-user and cross-tenant isolation, full chat booking incl. confirm, idempotent sends, AI outage fallback, AI logging, form bookings posted into the chat, pagination, error envelope.

## Deployment

### Option 1 — Render (API + database together)

1. Push this project to its own GitHub repository.
2. Render → **New → Blueprint** → select the repo. `render.yaml` creates the Postgres database and the API service.
3. In the `slotwise-api` service → **Environment**, set `CORS_ORIGINS` (your frontend URL) and `MISTRAL_API_KEY`.
4. Check `https://<your-service>.onrender.com/health` returns `"status":"ok"`.

Render's free Postgres expires after 30 days — fine for an assessment, otherwise use option 2.

### Option 2 — Neon (database) + Render (API)

1. Create a free Neon project; copy the connection string (it ends with `?sslmode=require`).
2. Render → **New → Web Service** → this repo.
   - Build command: `npm ci --include=dev && npm run build`
   - Start command: `node dist/db/migrate.js --seed && node dist/server.js`
   - Health check path: `/health`
3. Environment: `NODE_ENV=production`, `DATABASE_URL=<neon url>`, `DATABASE_SSL=true`, `JWT_SECRET=<random>`, `TRUST_PROXY=1`, `CORS_ORIGINS=<frontend url>`, `MISTRAL_API_KEY=<key>`.

The Render service must support WebSockets (all web services do). Docker: `docker build -t slotwise-backend .` — the image applies schema + seed on start.

## Project structure

```
src/
  ai/                  AI boundary: types + zod schema, prompt, Mistral client, LLM + rule-based interpreters, logging
  config/env.ts        validated configuration
  db/                  pg pool, transaction helper, migration runner
  middleware/          auth, validate, rate limit, request logger, error handler
  modules/
    auth/              signup, login, me
    catalog/           businesses (tenants) + services
    appointments/      scheduling rules (pure), availability, booking, cancel
    chat/              conversations, orchestration, dialog policy
  realtime/socket.ts   Socket.IO server (per-user rooms)
  subscribers.ts       domain-event wiring
  app.ts / server.ts   Express app / HTTP + socket server
database/              schema.sql, seed.sql, README.md (design + indexing)
tests/                 unit + integration (Vitest, Supertest)
docs/                  api.http, DEMO_SCRIPT.md
```
