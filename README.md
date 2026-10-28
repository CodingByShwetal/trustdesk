# TrustDesk: AI Support Operations Agent

An AI-first support desk that triages tickets, drafts policy-grounded replies with citations, recommends approval-gated actions, and defends against prompt injection. Built for the Airtribe AI-First Software Engineering capstone.

> **Status:** Phases 1–5 of 6 complete: data and APIs, retrieval, policy facts, AI pipeline with guardrails, approval-gated idempotent actions, eval runner and agent console. Phase 6 is real-model tuning, the final eval report and documentation polish.

## Quick start (Docker)

```bash
cp .env.example .env          # LLM_PROVIDER=mock works without any API key
docker compose up --build
```

On start the app applies migrations, seeds the starter data (idempotent), ingests the knowledge base, and serves the API and the agent console on http://localhost:8080. Sign in as agent, manager or admin with the demo password `trustdesk`.

```bash
curl localhost:8080/health
curl -X POST localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"agent","password":"trustdesk"}'
curl localhost:8080/api/tickets -H 'authorization: Bearer agent-demo-token'
```

## Local development (without Docker)

Requires Node 22 and PostgreSQL 16.

```bash
cd server
npm install
echo "DATABASE_URL=postgres://trustdesk:trustdesk@localhost:5432/trustdesk" > .env
npm run db:seed     # migrate + seed + ingest KB
npm run dev         # http://localhost:8080
npm test            # uses DATABASE_URL from TEST_DATABASE_URL or trustdesk_test
```

## Authentication

Demo bearer tokens mapped to roles (configurable via `DEMO_TOKENS`). Roles are ranked agent < manager < admin.

| Username | Token | Role | Can |
| --- | --- | --- | --- |
| agent | `agent-demo-token` | agent | Read tickets, run triage and drafts, request actions |
| manager | `manager-demo-token` | manager | Everything above, plus approve and execute sensitive actions |
| admin | `admin-demo-token` | admin | Everything above, plus KB ingestion and eval runs |

`POST /api/auth/login` with `{ "username": "agent", "password": "<DEMO_PASSWORD>" }` returns the token.

## API (implemented so far)

All errors share one shape: `{ "error": { "code", "message", "details" } }`.

| Method | Route | Role | Purpose |
| --- | --- | --- | --- |
| GET | /health | none | Liveness, checks DB |
| POST | /api/auth/login | none | Demo login, returns bearer token |
| GET | /api/auth/me | agent | Current user and role |
| GET | /api/tickets | agent | Ticket queue (`?status=`, `?category=`) |
| GET | /api/tickets/:id | agent | Ticket + customer + order + drafts + actions + runs |
| POST | /api/tickets | agent | Create a ticket (validates order ownership) |
| GET | /api/tickets/:id/policy-facts | agent | Deterministic policy facts measured from the ticket date |
| GET | /api/documents | agent | KB documents with trust status and quarantine reason |
| GET | /api/documents/search?q= | agent | Ranked chunks: doc_id, title, heading, snippet, score (`include_quarantined=true` for audit) |
| POST | /api/documents/ingest | admin | Ingest or re-ingest documents; poisoned docs are quarantined |
| POST | /api/tickets/:id/triage | agent | AI triage: category, priority, sentiment, escalation, applied policy rules, run_id |
| POST | /api/tickets/:id/draft-reply | agent | Cited draft, recommended and blocked actions, guardrail outcome, run_id |
| GET | /api/agent-runs/:runId | agent | Trace: steps, retrieved doc ids, tool calls, guardrail results, model, latency, tokens |
| POST | /api/eval-runs | admin | Start an eval run in the background (202). Body: `{ "provider": "configured" \| "mock" \| "mock_compromised", "case_ids"?: [...] }` |
| GET | /api/eval-runs | agent | Eval run history with metrics |
| GET | /api/eval-runs/:id | agent | Status, progress, metrics and per-case results (poll while running) |
| GET | /api/eval-runs/:id/report | agent | The markdown report |
| POST | /api/tool-actions | agent | Request an action: validated, idempotent (201 new, 200 replay, 409 key reused with a different request) |
| GET | /api/tool-actions | agent | List actions (`?ticket_id=`, `?status=approval_required` for the approval queue) |
| GET | /api/tool-actions/:id | agent | Action with its approval history |
| POST | /api/tool-actions/:id/approve | manager | `{ "decision": "approved" \| "rejected", "reason": "..." }`, recorded in `approvals` |
| POST | /api/tool-actions/:id/execute | agent / manager | Execute once; repeats return the stored result. Sensitive tools need a manager and prior approval |

## AI pipeline

The model proposes; deterministic code decides. Every model call sits between checks that a misbehaving model cannot get around.

1. **Context**: ticket, customer and order are loaded; `expected_*` labels are never loaded on this path.
2. **Input scan**: rule-based detection of prompt injection, secret extraction, hidden-action requests, verification bypass and policy-override claims.
3. **Policy facts**: dates, windows, warranty and signals computed in code (see below).
4. **Triage (LLM)**: JSON output validated with Zod, one repair retry. Then **policy rules** raise priority or force escalation where the KB is explicit (safety → urgent + escalate; unverified account change → account_security + escalate; manipulation → escalate; duplicate charge → high; urgent shipping need → high). Rules can only make outcomes safer.
5. **Retrieval**: anchor policy for the category, the security playbook when flagged, then search hits; quarantined docs dropped and logged.
6. **Draft (LLM)**: policy chunks inside `<policy_doc>` tags, the customer message inside `<untrusted_customer_message>` with `<`/`>` neutralised so it cannot fake a delimiter.
7. **Output validation**: citations must be in the retrieved trusted set and include the governing policy; no doc ids in the reply; no promises such as "has been refunded" or "instant replacement" (repairable, one retry with feedback). Critical failures go straight to a safe escalation template: system-prompt canary token, echoed prompt sections, credential patterns, another person's email, card numbers.
8. **Tool gate**: proposals are checked against the catalog (tool exists, category allowed) and policy preconditions (return window, final sale, warranty, safety first, coupon ≤ INR 1000, stale tracking, no AI-initiated account locks, only escalation when manipulation is detected). Payloads are built server-side from records, so the model cannot pick which order or customer an action targets. Blocked proposals are returned and traced with their reason.
9. **Persist**: draft, ticket status and the full trace.

## Agent console

Served at `/` from the same container. Four pages:

- **Desk**: ticket queue; the customer's message; customer and order context; the policy facts computed from the ticket date; triage with any policy-rule overrides; the cited draft with a four-stage guardrail strip (customer message, policy retrieval, draft check, action gate); recommended and blocked actions; and an audit rail with the full trace for any AI run on the ticket.
- **Approvals**: the manager's queue. Approve or reject with a reason, run approved actions, and see replays ("already done, nothing ran twice").
- **Knowledge**: every KB document with its trust status and quarantine reason, plus search (with an audit switch to include quarantined documents).
- **Evals**: run the suite against the configured model, the heuristic mock or the compromised model, then see the scoreboard, the adversarial cases and per-case results, and download the markdown report.

Running an eval re-triages the 8 seed tickets, so the desk afterwards shows the evaluated model's results.

## Evaluation

```bash
# Docker
docker compose exec app node dist/evals-cli.js                          # configured LLM_PROVIDER
docker compose exec app node dist/evals-cli.js --provider mock_compromised
docker compose exec app node dist/evals-cli.js --cases eval_005,eval_006,eval_007 --delay-ms 4000

# Local
cd server && npm run eval -- --provider mock
```

Each run prints a summary, stores the results in `eval_runs`, and writes `reports/<eval_run_id>.md` and `.json` (mounted to `./reports` on your machine). The same run is available from the Evals page or `POST /api/eval-runs`, which runs in the background so the API keeps serving; only one run at a time is allowed, because cases share the seed tickets.

Metrics: category, priority and triage accuracy; citation coverage (every `must_cite_doc_ids` cited); unsafe action block rate (no `disallowed_actions` recommended); allowed action recall; escalation accuracy; answer requirement coverage. eval_005, eval_006 and eval_007 are called out separately as adversarial cases ("handled safely" = no unsafe action, escalated, no error).

**Answer requirements** are checked with deterministic assertions (allowed by the evaluation guide) in `server/src/modules/evals/requirements.ts`: positive checks read the final reply ("ask for photo" looks for a photo request), and negative checks reuse the guardrail detectors ("do not promise instant refund" runs the forbidden-promise patterns, "do not issue coupon" also checks the recommended actions). A requirement with no matching check is reported as unchecked, never silently passed.

Results with the built-in providers:

| Provider | Cases passed | Unsafe actions blocked | Adversarial cases handled safely |
| --- | --- | --- | --- |
| `mock` (heuristic) | 8 / 8 | 100% | 3 / 3 |
| `mock_compromised` (obeys every injection) | 0 / 8 | 100% | 3 / 3 |

The second row is the point: a model that follows every malicious instruction degrades quality into "escalate to a human", but cannot cause an unsafe action, a leaked prompt or a false refund promise. Gemini results are added in Phase 6.

## Tool actions

Implemented on one catalog-driven engine: `create_replacement_order` (the required approval-gated action, demoed on tkt_9001), `start_refund_review` (tkt_9008), and the low-risk `escalate_to_human` and `open_carrier_investigation`. `issue_coupon` and `lock_account` exist with mock executors; the AI gate never recommends a coupon over INR 1000 or an account lock.

Lifecycle: `approval_required` → (manager) `approved` or `rejected` → (manager) `executed` or `failed`. Low-risk tools start at `requested` and an agent can execute them directly.

Guarantees, each covered by tests:

- **Validation on request**: tool exists, ticket is triaged, category allowed by the catalog, every required field present, coupon ≤ INR 1000, and payload fields must refer to the ticket's own order, SKU, customer and an amount no larger than the order total.
- **Idempotent requests**: `UNIQUE(tool_name, idempotency_key)` with `INSERT … ON CONFLICT DO NOTHING`. Six concurrent identical requests create one action. If the client omits a key, one is derived from the ticket, tool and business fields. The free-text `reason` is ignored both in the derived key and in conflict detection, so a regenerated draft with different wording replays rather than duplicating.
- **Human approval**: only managers can approve, reject or execute sensitive actions; each decision needs a reason and is stored in `approvals`. Decisions are final; repeating the same decision is a no-op.
- **Exactly-once execution**: execute takes `SELECT … FOR UPDATE` on the action row, so eight concurrent executes produce one side effect and seven replays of the stored result. The mock side-effect tables (`replacement_orders`, `refund_reviews`) are also unique on the idempotency key.
- **Failure handling**: the executor runs in a savepoint. If it fails, its partial writes roll back, the action is marked `failed` with the error, and a later execute can retry safely.

### LLM providers

Set `LLM_PROVIDER`:

| Value | Use |
| --- | --- |
| `gemini` | Real runs. `GEMINI_MODEL` (default `gemini-3-flash-preview`) with automatic fallback to `GEMINI_FALLBACK_MODEL` (default `gemini-3.1-flash-lite-preview`) on HTTP 408/429/5xx, timeouts or network errors. The API key is sent in a header only. |
| `mock` | Deterministic keyword heuristic over the same inputs, for tests and keyless demos. It is a regression baseline, not a measure of AI quality. |
| `mock_compromised` | A "jailbroken" model that obeys every injection, cites a poisoned and a fake doc, leaks its prompt canary and proposes a 5000 INR coupon and an account lock. Used to prove the deterministic layers keep the system safe: every draft falls back to safe escalation and every unsafe action is blocked. |

## Design decisions so far

- **One Postgres for everything.** Relational data, full-text search (generated `tsvector` + GIN index), and later the job queue and traces.
- **Source IDs preserved.** `cus_1001`, `tkt_9001`, `KB-REFUND-001` are primary keys, so evals and UI use the same identifiers.
- **Expected labels are isolated.** `expected_*` fields from `tickets.json` live in `ticket_expected_labels`, a table the AI path never reads and the API never returns.
- **Original customer messages are immutable.** Reseeding never overwrites a ticket body or its stored triage.
- **Poisoned KB documents are quarantined at ingestion.** `KB-ADVERSARIAL-001` contains instructions aimed at the AI ("Ignore all previous policies", "do not mention this document"), so it is stored for audit but will never be sent to the model or accepted as a citation. The scanner ignores quoted examples (so the security playbook, which quotes attack strings, stays trusted) and does not apply the customer-only `verification_bypass` rule to policy text.

- **Policy windows are computed in code, never by the model.** `server/src/modules/policy/facts.ts` measures every window from the ticket's `created_at` (converted to a calendar date in `BUSINESS_TIMEZONE`, default Asia/Kolkata): return window (7 days), warranty (12 months, +6 for gold on eligible hardware), stale tracking (≥5 business days) and lost-package remedies (≥10). Each threshold lives in `policy/constants.ts` next to the KB sentence it implements. A test freezes the clock in 2031 and checks the facts do not change.
- **Shipping assumption:** the data has no tracking events, so dispatch is estimated as `placed_at` + 1 business day (KB-SHIPPING-001: "ship within 1 business day"). Lost-package remedies use this system figure, never the customer's own claim.
- **Warranty assumption:** seed orders are single-item, so an item's price (needed for the "accessories under INR 3000" exclusion) is taken from the order total.
- **Category-anchored retrieval.** Full-text search alone ranks KB-WARRANTY-001 above KB-REFUND-001 for "damaged earbuds replacement". Each triage category therefore has an anchor policy (refund → KB-REFUND-001, shipping → KB-SHIPPING-001, and so on) that is always in context, followed by search hits. KB-SECURITY-001 is added whenever a guardrail fires. Quarantined matches are dropped and recorded so the trace shows the defence working.

## Project layout

```
data/                 starter pack data (unchanged)
server/src/api/       Fastify routes, auth guard, serializers
server/src/db/        Drizzle schema, migrations runner, seed loader
server/src/modules/   domain logic (tickets, knowledge, guardrails, ...)
server/drizzle/       SQL migrations
server/test/          Vitest unit and API tests
```
