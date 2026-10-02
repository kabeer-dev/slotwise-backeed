# Demo video script (≈3 minutes)

Before recording: reset the data (`npm run db:reset` in slotwise-backend), start the frontend (slotwise-frontend), have the app open signed out, and the README open in another tab.

| Time | Show | Say |
|---|---|---|
| 0:00 | README architecture diagram | "Next.js front end, Express API, PostgreSQL, Mistral for language understanding, Socket.IO for live updates. The key boundary: the AI interprets, the code decides." |
| 0:20 | Login page → *Fill in the demo account* → Sign in | "JWT auth. The right panel already shows this patient's upcoming appointment." |
| 0:35 | **New chat** → type *I need a dental cleaning* | "The model classifies intent and extracts the service. Quick replies are real next working days." |
| 0:55 | Type *Monday at 10am* | "That slot is taken — the scheduling rules caught it, not the model, and these alternatives come from the live calendar." |
| 1:10 | Tap *11:30 AM* → summary ticket | "Nothing is booked yet. The summary is built from database values." |
| 1:20 | **Confirm booking** | "Confirmation goes through a dedicated endpoint with no AI call. Watch the appointments panel update over the socket." |
| 1:35 | Type *show my appointments* | "Multi-turn memory and other intents." |
| 1:45 | Type *book a physio session #ai-down* | "In mock mode this simulates an LLM outage: the chat degrades to a structured form, prefilled with whatever was captured." |
| 2:05 | Fill the inline form and book | "A form booking made inside a conversation is posted back into it." |
| 2:20 | Terminal: `psql slotwise -c "select status, latency_ms, prompt_tokens from ai_interactions order by id desc limit 5"` | "Every AI call is logged: status, latency, tokens, raw and parsed output." |
| 2:35 | `database/schema.sql` → `appointments_no_overlap` | "Double booking is impossible at the database level — an exclusion constraint, covered by a concurrency test." |
| 2:50 | `npm test` output | "66 tests, including integration tests against real Postgres and contract tests for the Mistral client." |

## Likely interview questions — short answers

- **Why not let the model book directly (function calling)?** A booking is a write with business rules. Keeping the model to interpretation means a hallucination can produce a wrong *question*, never a wrong *booking*. Function calling would be a reasonable next step for richer intents, still routed through the same validation.
- **What if the model returns garbage?** zod validation; bad fields become null; no reply = failed turn → form fallback. Logged as `invalid_output`.
- **How do you prevent double booking under concurrency?** GiST exclusion constraint on the time range; violation (`23P01`) maps to 409 with alternatives.
- **How does it scale?** Stateless API except three in-memory pieces (rate limits, turn lock, socket rooms) → Redis store / lock / adapter. DB: indexes per query; partition `chat_messages` and `ai_interactions` by month at volume.
- **Multi-tenancy?** `business_id` from the JWT on every query, composite FKs make cross-tenant references impossible, next step Row-Level Security.
- **Why Socket.IO and REST both?** Writes stay on REST (validation, rate limits, tests). The socket only pushes changes — multi-tab sync, typing state, live appointment list.
- **Small change you could make live:** add a service in `seed.sql`; change opening hours in `businesses`; tweak `MAX_STALLED_TURNS` in `bookingDialog.ts`; add an intent to `INTENTS` + the prompt + a dialog branch.
