# Automated Weekly Business Report

> Pulls your weekly metrics from Postgres, has an LLM write the executive
> summary, renders a polished PDF (stat cards + chart + table), and emails it to
> your stakeholders — automatically, every week.

**What makes it portable, not a demo:** it **adapts to your database on its
own**. You don't hand-write SQL or edit any code per company. Point it at your
Postgres, run one setup command, and an LLM inspects your schema, proposes the
weekly metrics, writes the SQL, and self-checks each query against your live
database until it runs. You approve once; from then on the weekly pipeline runs
on your data untouched.

The repo ships in **demo mode** — a Docker Postgres seeded with realistic fake
data — so you can watch the entire pipeline work before pointing it at anything
real.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start (demo mode)](#quick-start-demo-mode)
- [Reporting on your own data](#reporting-on-your-own-data)
- [Email: setup and verifying delivery](#email-setup-and-verifying-delivery)
- [How queries stay safe](#how-queries-stay-safe)
- [Performance at scale](#performance-at-scale)
- [Automated weekly delivery](#automated-weekly-delivery)
- [Admin dashboard](#admin-dashboard)
- [Reliability](#reliability)
- [Configuration reference](#configuration-reference)
- [Architecture](#architecture)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## Features

- **Self-adapting** — one `npm run setup` generates and validates your metric
  SQL from your schema. No per-company code changes, no hand-written SQL.
- **Safe by construction** — every query runs in a server-enforced read-only
  transaction with a timeout; writes are rejected by Postgres itself, not just
  by a text check. See [How queries stay safe](#how-queries-stay-safe).
- **Resilient** — a single failing metric is logged and omitted (the report
  still goes out and says which metric was dropped); a slow chart or big table
  won't crash the run. Nothing is silently swallowed.
- **Professional PDF** — responsive stat-card grid (3–6 metrics), a gradient
  trend chart, and a clean data table, all self-contained (no network at render
  time).
- **Autonomous delivery** — a cron scheduler emails the report every week; a
  failure alerts you over Slack and/or email.
- **Admin dashboard** — browse past runs, download PDFs, edit metrics/SQL,
  manage recipients, and **send a test email to verify delivery** — all behind
  HTTP Basic Auth.
- **Self-hosted per company** — each deployment has its own `.env`, database,
  and SendGrid account. Not multi-tenant; your data stays yours.

## Requirements

- **Node.js 20+**
- **Docker** (for the demo Postgres, the scheduler, and the dashboard) — or your
  own **PostgreSQL** database
- A **SendGrid** account for email (optional — without it, PDFs are still saved
  locally)
- An **LLM API key** for `npm run setup` — [Groq](https://console.groq.com) has
  a free tier; any OpenAI-compatible provider works

## Quick start (demo mode)

```bash
npm install
docker compose up -d db      # local Postgres seeded with fake data
cp .env.example .env         # fill in keys as needed (see below)
npm run report:run           # writes output/weekly-report-*.pdf
```

`db/init.sql` seeds `users` and `orders` with ~10 weeks of signups, orders, and
churn, so every metric and the chart have realistic data. With no configuration
at all, the pipeline runs a built-in **demo report definition** (sales /
signups / churn) against that schema — open the generated PDF in `output/` to
see the finished product.

## Reporting on your own data

No application code to edit, no SQL to write by hand. Three steps.

### 1 — Point `DATABASE_URL` at your database

```env
DATABASE_URL=postgres://your_user:your_pass@your-db-host:5432/your_db
```

Use a **read-only** role if you can. You don't have to rely on it — the app
enforces read-only execution itself — but it's the strongest guarantee and
free to set up.

### 2 — Generate your metrics: `npm run setup`

With `DATABASE_URL` and an LLM key set:

```bash
npm run setup
```

1. **Introspect** — reads table, column, and foreign-key *names* only. No row
   data is sent to the LLM (there's an explicit opt-in for sample values; it's
   off by default). Very large schemas are summarized to fit the model's
   context automatically.
2. **Propose** — 3–6 weekly metrics plus a daily trend chart, each with SQL
   obeying a fixed contract: a metric returns one row with a `value` column and
   an optional `prior_value` (for the week-over-week delta); `$1` is the as-of
   timestamp.
3. **Self-validate** — runs every generated query read-only against your live
   database. Anything that errors or returns the wrong shape is fed back to the
   model to fix, up to three rounds. Queries that still fail are dropped and
   reported — never silently kept. (A query that forgets to scope itself to the
   reporting window with `$1` can't even run: every query is executed *with* the
   as-of timestamp, so Postgres rejects one that ignores it — you can never
   silently get an all-time total in place of the week.)
4. **Review the real numbers, then approve** — shows each metric, its SQL, and
   **the actual value it just returned** on your data (e.g. `→ returns $368,320,
   prior $259,489 (+41.9% vs prior)`), so an obviously-wrong number is caught by
   eye even when the SQL looks fine. Objective red flags are called out too — a
   "percent" metric whose value lands outside 0–100 (usually a raw count
   mislabeled as a rate), a lower-is-better metric (churn, refunds) not marked as
   such, a format/label mismatch. These flags are **advisory** and never block
   approval. On a yes it writes `output/report-definition.json`, the single file
   that drives the pipeline from then on.

Re-run any time to regenerate. `npm run setup -- --yes` (or
`SETUP_AUTO_APPROVE=1`) skips the prompt for automation; running
non-interactively **without** `--yes` does a safe dry run (prints the proposal,
writes nothing).

> **Honest caveat — read this.** Self-validation guarantees each query
> *executes and returns the right shape*. It does **not** guarantee the query
> measures the *semantically correct* thing — a model can write a query that
> runs perfectly and still counts the wrong rows. That's exactly why setup shows
> you the **actual value** each query returns and flags the mistakes a machine
> can see: to make your one approval well-informed rather than blind. **You are
> the correctness gate** — read the numbers (and the SQL) before approving.

Prefer a UI? The dashboard's **Configure** page shows every metric and its SQL
in editable fields — each with the same real-value preview and advisory flags —
plus **Regenerate with AI** and a **Save** that re-runs the same read-only
validation before persisting. `npm run db:validate` re-checks the active
definition against your database any time and tells you exactly which query is
broken and why.

## Email: setup and verifying delivery

Each deployment uses its **own** SendGrid account — nothing is shared between
copies of this project.

1. Sign up at sendgrid.com → **Settings → API Keys → Create API Key** →
   **Custom Access**, and enable two scopes: **Mail Send** (required, to send at
   all) and **Suppressions → Suppressions: Read** (recommended, so the pipeline
   can skip addresses that have bounced or complained — see *Deliverability*
   below). A Mail-Send-only key still sends; it just can't filter bad addresses.
2. **Settings → Sender Authentication → Single Sender Verification** — verify
   the address you want reports sent *from*, and click the link SendGrid emails
   you. **This step is mandatory:** SendGrid rejects sends from an unverified
   address with a 403.
3. In `.env`:
   ```env
   SENDGRID_API_KEY=SG.xxxxx
   SENDGRID_FROM_EMAIL=<the address you just verified>
   REPORT_RECIPIENTS=exec1@company.com,exec2@company.com
   ```

`REPORT_RECIPIENTS` is exactly who receives the report. You can also manage
recipients from the admin **Settings** page without editing `.env`.

**Verify it actually works — without waiting for the weekly run.** Open the
admin dashboard → **Settings → Verify email delivery**, enter your address, and
click **Send test email**. It sends a real message through the same API key and
verified sender the report uses and reports the exact result — success, a
missing key, an unverified-sender rejection, or SendGrid's own error message —
so you know delivery works before the first scheduled run. (Leave
`SENDGRID_API_KEY` blank entirely and the weekly report still runs; it just
saves the PDF to `output/` and skips the email.)

### Deliverability: domain authentication & bounce handling

Getting mail *accepted* (not spam-foldered) is separate from getting SendGrid to
*send* it. Two things matter, and one command checks both.

**Authenticate your sending domain.** A single Verified Sender is enough to send,
but the big inbox providers trust mail far more when the domain is authenticated:

- **DKIM** — SendGrid → **Sender Authentication → Authenticate Your Domain**
  gives you CNAME records (e.g. `s1._domainkey.yourdomain.com`) to add to DNS.
  This is the strongest signal.
- **SPF** — a TXT record `v=spf1 include:sendgrid.net ~all` authorizes SendGrid
  to send for your domain.
- **DMARC** — a TXT record at `_dmarc.yourdomain.com` (start with
  `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`, tighten later).

You must send from a **domain you own**. A freemail from-address
(`…@gmail.com`, `…@outlook.com`, etc.) can't be DKIM-signed by you and will fail
DMARC at the receiver — `check:email` treats it as a hard error, as it does the
shipped `reports@example.com` placeholder.

**Bounce & complaint handling is automatic.** Before each send, the pipeline
pulls SendGrid's suppression lists (hard bounces, spam complaints, invalid and
blocked addresses) and silently skips any matching recipient — knowingly
re-mailing a bad address hurts deliverability for *everyone* on the list. This is
best-effort: if the suppression API can't be reached it logs a warning and sends
anyway (it never blocks the report). It needs the key's **Suppressions: Read**
scope; a Mail-Send-only key gets a 403 and filtering is skipped with an
actionable log line.

**Check it in one command — without sending anything:**

```bash
npm run check:email          # prints a JSON deliverability report
npm run check:email -- --alert   # also fire an ops alert (see Reliability) on failure
```

It reports the sending domain's SPF/DKIM/DMARC status and a suppression summary.
Exit code **0** = deliverable (a missing DKIM/DMARC record is a *warning*, still
0), exit **1** = unusable sender (freemail or the unconfigured placeholder) —
ideal for a cron/monitor check.

### Which LLM key, which model

`npm run setup` and **Regenerate with AI** need an LLM key — that's the AI
writing your SQL. Default provider is Groq; set `GROQ_API_KEY`.

- Different OpenAI-compatible provider (OpenAI, Together, a local server)? Set
  `LLM_BASE_URL` and use its key.
- `GENERATOR_MODEL` picks the model that *generates* SQL; schema-to-SQL benefits
  from a stronger model, so you can point it at a bigger one just for setup.
- The **executive summary** is separate: with no LLM key the report still runs
  and uses a templated one-line summary. Only setup/regeneration require a key.

## How queries stay safe

Setup and the admin UI execute SQL an LLM (or a human) wrote, potentially
against production. Execution is locked down in layers, **server-enforced
first** — the design does not depend on you having a read-only role:

1. **Read-only transaction (server-enforced).** Every metric and trend query, at
   setup *and* on every run, executes inside `BEGIN TRANSACTION READ ONLY` with
   a `SET LOCAL statement_timeout`. Postgres rejects any write or DDL inside it
   (SQLSTATE `25006`) regardless of the SQL text, and the timeout
   (`DB_STATEMENT_TIMEOUT_MS`) bounds a runaway query.
2. **Single statement only.** Every query is parameterized (`$1`), forcing the
   driver's extended protocol — which permits exactly one statement, so nothing
   can be stacked after it.
3. **Static guard (defense in depth).** Before a query is sent, comments are
   stripped and it must begin with `SELECT`/`WITH` with no stray semicolons — an
   obviously-wrong query is rejected fast with a clear message.
4. **Read-only role (recommended).** Pointing `DATABASE_URL` at a read-only role
   is the belt-and-suspenders guarantee on top of all the above.

## Performance at scale

Every metric filters a narrow time window (the reporting week), so with an index
on the timestamp column each query filters on, the queries stay fast on large
tables — they scan the week, not all of history. Measured here on a 5-million-row
`orders` table (laptop Postgres, median of 3 runs):

| Query | No index | Indexed |
|---|---|---|
| Weekly aggregate (sum / count over the week) | 60–500 ms | 5–105 ms |
| Daily trend (the 7-day chart) | 1.9 s — full table scan | 80 ms |

Two things keep this true on **your** data:

- **Index the columns your queries filter on** — the single biggest factor. If a
  metric filters `orders.created_at`, that column wants an index
  (`CREATE INDEX ON orders (created_at)`); otherwise Postgres rescans the whole
  table every run. The AI is instructed to write **sargable** SQL (it
  range-filters the raw timestamp instead of wrapping it in a function like
  `date_trunc(created_at)`, which would defeat the index), but the index itself
  has to exist in your database.
- **Prove it before you trust it** — `npm run benchmark` runs every query in your
  active definition against your database, reports how long each takes, and flags
  any that sequentially scan a large table, naming the column that wants an index:

  ```
  ✓ metric "total_sales"      2 ms   [index]
  ⚠ trend                  1909 ms   [1 seq scan(s)]
     ↳ sequential scan of 5,000,000 rows on "orders" — add an index on the column this query filters/joins on
  ```

Every query is also bounded by `DB_STATEMENT_TIMEOUT_MS` (default 30s), enforced
by Postgres itself — a runaway query is cancelled (SQLSTATE `57014`), never left
to hang the run. Raise it if a legitimate heavy aggregation needs longer.

## Automated weekly delivery

`npm run report:run` generates one report on demand. To have it run itself every
week, keep the scheduler alive:

```bash
docker compose --profile scheduler up -d db scheduler admin
```

Three long-lived containers start: Postgres, a cron-driven scheduler (fires on
`REPORT_CRON`, default `0 8 * * 1` — Mondays 8am), and the admin dashboard.
`restart: unless-stopped` means they survive a reboot while Docker is running.
Haven't run `npm run setup` yet? The scheduler logs a reminder and runs the
built-in demo definition.

> **Set `REPORT_TIMEZONE` in Docker.** A container's clock is almost always UTC,
> so without it `0 8 * * 1` fires at 8am *UTC*, and the daily-trend day
> boundaries and "week ending" label are computed in UTC too. Set
> `REPORT_TIMEZONE` to the company's IANA zone (e.g. `America/New_York`) and all
> three line up with local time. The scheduler logs the active zone on startup.

## Admin dashboard

```bash
docker compose up -d admin        # or: npm run admin:start
```

Visit `http://localhost:4000`:

- **Dashboard** — every past run, whether each email send succeeded,
  preview/download any PDF, or trigger an ad-hoc run. A live **System status**
  panel at the top shows database reachability, whether the scheduler is alive,
  and when the last report went out.
- **Configure** (`/configure`) — view/edit every metric and its SQL,
  **Regenerate with AI**, and **Save** with read-only re-validation.
- **Settings** (`/settings`) — manage recipients without editing `.env`, a
  **test-mode** toggle that routes all sends to one address, and **Send test
  email** to verify delivery.

**Login:** protected by HTTP Basic Auth once `ADMIN_USERNAME`/`ADMIN_PASSWORD`
are set. Leave both blank only for local-only use — otherwise anyone who reaches
the port can trigger runs and download PDFs (a warning is logged at startup).
It's further hardened with CSRF tokens, a brute-force lock-out, security headers,
and an audit log — see [Security notes](#security-notes).

## Reliability

- **Retries** — a transient metrics failure is retried once after 2s before
  giving up.
- **PDF rendering** — headless Chrome is the one heavy, crash-prone step, so it
  is hardened for unattended use: every DevTools call is bounded by
  `PDF_RENDER_TIMEOUT_MS` (default 60s), so a Chrome that wedges or is
  OOM-killed mid-render **fails fast instead of hanging the job**; that failure
  is retried once with a fresh browser; and the browser process is always
  cleaned up — force-killed if it won't close, so runs can't leak Chrome
  processes and slowly exhaust host memory. A launch failure surfaces an
  actionable message (install Chromium / give the container more memory) rather
  than a raw spawn error.
- **Partial reports** — if one metric's query fails, it's logged and omitted;
  the report still sends and names the omitted metric. Only if *every* metric
  fails does the run abort.
- **Failure alerts** — a run that fails after retry notifies you over Slack
  and/or email if configured (`SLACK_WEBHOOK_URL`, `ALERT_EMAIL`); otherwise the
  failure is in `output/run-log.json` and the container logs.
- **Health checks** — the admin exposes two unauthenticated probes: `/health`
  (fast liveness — is the process serving?) and `/status` (deep JSON: database
  reachability, the active definition, **scheduler liveness**, and last-run
  status, returning `503` when something is actually broken). `npm run healthcheck`
  runs the identical check from the CLI and exits non-zero on failure — point an
  uptime monitor at `/status`, or cron `npm run healthcheck -- --alert` to be
  pushed a Slack/email alert if the **scheduler process itself dies** (not only
  when a run fails). The dashboard shows the same status at a glance.
- **Deliverability checks** — `npm run check:email` verifies the sending domain's
  SPF/DKIM/DMARC and summarizes SendGrid's suppression lists *without sending
  anything*, exiting non-zero when the from-address is unusable (freemail or the
  unconfigured placeholder). Cron `npm run check:email -- --alert` to be notified
  if email would silently stop landing. See
  [Deliverability](#deliverability-domain-authentication--bounce-handling).
- **Retention** — archived PDFs and `run-log.json` entries older than
  `RETENTION_DAYS` (default 90) are pruned automatically after each run.
- **Concurrency lock** — the scheduler and the dashboard's "Run Report Now"
  can't double-fire; a lock file means only one run executes at a time (a second
  trigger is skipped and logged, not dropped silently).
- **Structured logs** — one JSON object per line, ready for a log aggregator
  (Docker json-file, CloudWatch, Loki, …).

## Configuration reference

All configuration lives in `.env` (copy from `.env.example`). Only
`DATABASE_URL` is strictly required for a demo run.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | demo container URL | Postgres connection string. Use a read-only role in production. |
| `SENDGRID_API_KEY` | *(empty)* | SendGrid key (Mail Send scope). Empty = skip email, save PDF only. |
| `SENDGRID_FROM_EMAIL` | `reports@example.com` | **Must be a SendGrid Verified Sender**, or sends are rejected (403). |
| `REPORT_RECIPIENTS` | *(empty)* | Comma-separated recipients. Can also be set in the dashboard. |
| `GROQ_API_KEY` | *(empty)* | LLM key for `npm run setup` and the AI summary. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Model for the executive summary. |
| `LLM_BASE_URL` | Groq endpoint | OpenAI-compatible base URL for any provider. |
| `GENERATOR_MODEL` | = `GROQ_MODEL` | Model used to generate metric SQL at setup. |
| `REPORT_CRON` | `0 8 * * 1` | Weekly schedule (Mondays 8am), in `REPORT_TIMEZONE`. |
| `REPORT_TIMEZONE` | system zone | IANA zone the report is local to — cron fire time, trend day boundaries, and the "week ending" label. Set it in Docker (UTC clock). Invalid = startup error. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Per-query timeout. Raise for heavy aggregations on large tables. |
| `PDF_RENDER_TIMEOUT_MS` | `60000` | Upper bound on any single headless-Chrome call while rendering the PDF. A wedged/OOM-killed Chrome fails fast (then retries once) instead of hanging. Raise for very large reports on a slow host. |
| `DB_POOL_MAX` | `10` | Max concurrent Postgres connections. |
| `RETENTION_DAYS` | `90` | Days of archived PDFs / log entries to keep. |
| `SLACK_WEBHOOK_URL` | *(empty)* | Slack alert on a failed run. |
| `ALERT_EMAIL` | = recipients | Email alert on a failed run. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(empty)* | Dashboard Basic Auth. Set before exposing the port. |
| `ADMIN_PORT` | `4000` | Dashboard port. |
| `TRUST_PROXY` | `false` | Set `true` behind a TLS-terminating reverse proxy so client IP (rate limit + audit log) and HTTPS detection use the `X-Forwarded-*` headers. |

## Architecture

```
Postgres  →  report-definition.json  →  src/db (read-only executor)
          →  Groq / OpenAI-compatible LLM (executive summary)
          →  Handlebars + Chart.js (HTML)  →  Puppeteer (PDF)
          →  output/ (archive)  →  SendGrid (email)
```

`report-definition.json` — generated by `npm run setup`, or the built-in demo
default — is the single source of truth for which metrics run, their SQL, and
how they display. That's what makes the pipeline work on any schema. Every run
is logged to `output/run-log.json` (shown in the dashboard) whether or not the
email send succeeds — the PDF is always archived locally first.

## Testing

```bash
npm test            # app logic — no live DB / SendGrid / LLM needed
npm run test:db     # adds tests against a live DATABASE_URL
```

`npm test` uses Node's built-in runner (no extra dependency) and covers retry
logic, error-message extraction, the concurrency lock, retention pruning, the
settings store, recipient resolution, dashboard auth, report-definition
load/validate, and the generator's parsing/repair loop (LLM and DB faked).

`npm run test:db` additionally exercises the read-only executor against a real
database, confirming a legitimate `SELECT` works while a write hidden in a CTE
is rejected with SQLSTATE `25006`.

Neither replaces `npm run db:validate` or an actual `npm run report:run` on your
own data and credentials, but together they catch regressions in the app's
logic.

`npm run benchmark` is the third check: it times every query in your active
definition against your database and flags any that scan a large table without an
index. Run it once against your production data to confirm the weekly job stays
fast as your tables grow — see [Performance at scale](#performance-at-scale).

### Continuous integration

Every push to `main`/`master` and every pull request runs the full suite on
GitHub Actions — [.github/workflows/ci.yml](.github/workflows/ci.yml). It runs
the **same two commands** documented above, so CI proves exactly what you'd
prove locally:

1. `npm test` — the unit suite, with no database (the DB-backed tests skip).
2. `npm run test:db` — the same suite with `RUN_DB_TESTS=1`, this time against a
   real Postgres 16 service (seeded with [db/init.sql](db/init.sql)) and a real
   headless Chrome. This includes the full-pipeline integration test
   ([tests/pipelineIntegration.test.js](tests/pipelineIntegration.test.js)),
   which drives a live database → metric aggregation → executive summary → HTML →
   a real PDF and asserts the bytes come back as a valid `%PDF`.

No paid external services are touched: the integration test blanks the LLM key
(so the summary uses the deterministic templated fallback) and never calls
SendGrid — the chain stops at the PDF buffer. That is also why you can run
`npm run test:db` locally against `npm run db:up` with nothing but a database.

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| Test email fails with a 403 / "does not match a verified Sender Identity" | `SENDGRID_FROM_EMAIL` isn't verified. Verify it in SendGrid → Sender Authentication. |
| No email arrives, log says `no_api_key` | `SENDGRID_API_KEY` is empty. Set it, or accept PDF-only mode. |
| No email, log says `no_recipients` | Set `REPORT_RECIPIENTS` or add recipients in the dashboard. |
| A metric is missing and the report notes it was "omitted" | That metric's SQL failed against your data. Check the logs, then fix it on `/configure` or re-run `npm run setup`. |
| Query times out or is slow on a large table | Run `npm run benchmark` — it names the column that wants an index. Add it (`CREATE INDEX ON <table> (<column>)`), or raise `DB_STATEMENT_TIMEOUT_MS` if the aggregation legitimately needs longer. |
| `npm run setup` errors that the response was "cut off at the token limit" | Very large schema. Set a stronger `GENERATOR_MODEL`, or point at a DB user that sees fewer tables. |
| Chrome/Puppeteer crashes in Docker | The image installs the distro's Chromium (runs natively on both **amd64 and arm64** — Graviton/Ampere/arm-Mac hosts included) and launches it with `--no-sandbox --disable-dev-shm-usage --disable-gpu`. Every call is bounded by `PDF_RENDER_TIMEOUT_MS` (so a crash fails fast and retries once rather than hanging) and a stuck browser is force-killed. If renders fail repeatedly it's almost always memory — give the container a few hundred MB more (Chromium is the heaviest step). |
| Dashboard has no login | `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset — set them before exposing it. |
| Locked out of the dashboard with `429` after mistyping the password | Brute-force protection: 10 failed logins from one IP triggers a 15-minute lock-out (even correct credentials wait it out). Give it 15 minutes, or restart the admin process to clear it. |
| Reports stopped arriving / is the scheduler alive? | Open `/status` or run `npm run healthcheck`. It reports whether the DB is reachable, whether the scheduler heartbeat is fresh, and when the last run succeeded. A **stale heartbeat** means the scheduler process died — restart it (`docker compose --profile scheduler up -d scheduler`). Cron `npm run healthcheck -- --alert` to be told automatically next time. |

## Security notes

- `.env` is gitignored — never commit real credentials.
- The app only ever runs read-only queries, enforced in layers (see [How
  queries stay safe](#how-queries-stay-safe)); still prefer a read-only Postgres
  role in production.
- **Review AI-generated SQL before approving.** Validation proves a query runs
  and returns the right shape, not that it measures the right thing.
- Scope the SendGrid key to **Mail Send only**, not full account access.
- Set `ADMIN_USERNAME`/`ADMIN_PASSWORD` before running the dashboard anywhere
  reachable beyond your machine.
- **The dashboard is hardened beyond the login:**
  - **CSRF protection** — every state-changing form carries a per-process
    synchronizer token and cross-origin POSTs are rejected, so a site that has
    your browser's cached Basic Auth credentials still can't trick it into
    triggering a run or changing settings.
  - **Brute-force throttle** — 10 failed logins from one IP within 15 minutes
    locks that IP out with `429` for the rest of the window.
  - **Security headers** — a strict Content-Security-Policy (the pages use no
    client-side JavaScript, so scripts are forbidden outright), plus
    `X-Frame-Options: DENY`, `nosniff`, and `Referrer-Policy: no-referrer`;
    HSTS is added when the request arrives over HTTPS.
  - **Audit log** — every run trigger, settings change, test email, and
    definition save/regenerate is written to `output/audit-log.json` with the
    authenticated user, client IP, and timestamp (and echoed to the logs).
- **Terminate TLS at a reverse proxy.** The app speaks plain HTTP by design so
  it can sit behind nginx / Caddy / a cloud load balancer that handles HTTPS —
  Basic Auth must only ever travel over TLS. Set `TRUST_PROXY=true` so the app
  reads the real client IP from `X-Forwarded-For` (rate limiting and the audit
  log stay per-client, not per-proxy) and treats `X-Forwarded-Proto: https` as
  secure so HSTS is sent. Leave it off for direct/localhost access, or clients
  could spoof those headers.
- **Self-hosted per company** — each deployment has its own `.env`, database,
  and SendGrid account. It is not multi-tenant; don't point two companies' data
  at one instance.
