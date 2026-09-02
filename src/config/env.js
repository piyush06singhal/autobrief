require('dotenv').config();

const { resolveTimezone } = require('../utils/timezone');

function parseRecipients(value) {
    return (value || '')
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean);
}

module.exports = {
    databaseUrl: process.env.DATABASE_URL,
    sendgridApiKey: process.env.SENDGRID_API_KEY || null,
    sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL || 'reports@example.com',
    reportRecipients: parseRecipients(process.env.REPORT_RECIPIENTS),
    groqApiKey: process.env.GROQ_API_KEY || null,
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    // OpenAI-compatible base URL. Defaults to Groq; point at OpenAI, Together,
    // a local server, etc. by setting LLM_BASE_URL. Used by src/ai/llmClient.js.
    llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
    // Model used by `npm run setup` to generate report SQL. Schema-to-SQL is a
    // harder task than the weekly summary, so this can be pointed at a stronger
    // model; defaults to the same model as the summary.
    generatorModel: process.env.GENERATOR_MODEL || process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    reportCron: process.env.REPORT_CRON || '0 8 * * 1',
    // The zone the report is "local" to: drives the cron fire time, the daily
    // trend's day boundaries, and the "week ending" label. Defaults to the
    // system zone (so a laptop run matches wall-clock expectations); a container
    // whose clock is UTC should set REPORT_TIMEZONE to the company's zone. An
    // explicitly-set-but-invalid value throws here rather than reporting wrong.
    reportTimezone: resolveTimezone({
        requested: process.env.REPORT_TIMEZONE,
        systemTz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
    alertEmail: process.env.ALERT_EMAIL || null,
    retentionDays: Number(process.env.RETENTION_DAYS) || 90,
    // How long a single metric/trend query may run before Postgres cancels it.
    // Generous by default so a heavy weekly aggregation on a large production
    // table isn't killed; lower it if you want a tighter guard.
    dbStatementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30000,
    // Upper bound on any single headless-Chrome operation when rendering the PDF
    // (applied as Puppeteer's protocolTimeout + the setContent timeout). Stops a
    // Chrome that wedges or gets OOM-killed mid-render from hanging the whole
    // job indefinitely — it fails, retries once, then alerts like any other
    // failure. Raise for very large reports on a slow host.
    pdfRenderTimeoutMs: Number(process.env.PDF_RENDER_TIMEOUT_MS) || 60000,
    // Max concurrent Postgres connections in the shared pool. Metrics run in
    // parallel, so this bounds how many queries hit the DB at once.
    dbPoolMax: Number(process.env.DB_POOL_MAX) || 10,
    adminUsername: process.env.ADMIN_USERNAME || null,
    adminPassword: process.env.ADMIN_PASSWORD || null,
    // Set to 1/true when the admin dashboard runs behind a reverse proxy (nginx,
    // Caddy, a cloud LB) that terminates TLS. It makes Express read the client's
    // real IP from X-Forwarded-For (so rate limiting and the audit log are
    // per-client, not per-proxy) and trust X-Forwarded-Proto (so HSTS is sent on
    // genuinely-HTTPS requests). Leave off for direct/localhost access, otherwise
    // clients could spoof those headers.
    trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
};
