const express = require('express');
const path = require('path');
const fs = require('fs');
const { runWeeklyReport } = require('../jobs/weeklyReport');
const { readLog } = require('../jobs/runLog');
const { readSettings, writeSettings } = require('../config/settings');
const { sendTestEmail } = require('../email/sendgrid');
const { getReportDefinition, saveReportDefinition, validateDefinition } = require('../config/reportDefinition');
const { generateReportDefinition, checkMetricShape, checkTrendShape } = require('../ai/generateReportDefinition');
const { lintDefinition, buildPreview } = require('../ai/lintDefinition');
const { isLlmConfigured } = require('../ai/llmClient');
const { runReadOnly } = require('../db/safeQuery');
const { assertConfig } = require('../config/validateConfig');
const { collectHealth } = require('../utils/health');
const { describeError } = require('../utils/describeError');
const { formatValue } = require('../utils/format');
const { computeDelta } = require('../utils/pctChange');
const { createBasicAuth } = require('./basicAuth');
const {
    securityHeaders,
    csrfField,
    csrfProtection,
    createRateLimiter,
    authThrottle,
    noteAuthSuccess,
    noteAuthFailure,
    clientIp,
} = require('./security');
const { record: recordAudit } = require('../utils/auditLog');
const { adminUsername, adminPassword, trustProxy } = require('../config/env');
const logger = require('../utils/logger');

// Fail fast on a missing DATABASE_URL, with a clear message rather than a raw
// stack trace the first time someone clicks "Run Report Now" or "Configure".
assertConfig();

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const PORT = process.env.ADMIN_PORT || 4000;

const app = express();
// Behind a TLS-terminating reverse proxy, trust its forwarding headers so
// req.ip (rate limiting, audit log) and req.secure (HSTS) reflect the real
// client rather than the proxy. Off by default — see TRUST_PROXY in .env.
if (trustProxy) app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false }));

// Security headers on every response (including the health probes and PDFs):
// a strict CSP, clickjacking/sniffing guards, and HSTS when actually on HTTPS.
app.use(securityHeaders);

// Health/status are registered before auth AND before the general rate limiter
// so container healthchecks and external uptime monitors don't need credentials
// and are never throttled into a false "down".
//   /health  — fast liveness probe (is this process serving?). Used by Docker's
//              healthcheck, so it stays cheap and DB-independent: a DB blip must
//              not make the admin container look dead and trigger a restart loop.
//              Left entirely unlimited so the container never flaps.
//   /status  — deep readiness probe (DB, definition, scheduler liveness, last
//              run). JSON for an uptime monitor; 503 when something is actually
//              broken (DB down or scheduler dead), 200 otherwise. Lightly rate
//              limited since it's unauthenticated and touches the DB.
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const statusLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
app.get('/status', statusLimiter, async (req, res) => {
    try {
        const health = await collectHealth();
        res.status(health.status === 'error' ? 503 : 200).json(health);
    } catch (err) {
        logger.error('Health check failed to run', { error: describeError(err) });
        res.status(503).json({ status: 'error', detail: describeError(err) });
    }
});

// Everything below is the human-facing dashboard. A generous global limiter
// bounds accidental floods / scraping without getting in a real operator's way.
app.use(createRateLimiter({ windowMs: 5 * 60 * 1000, max: 600 }));

// Brute-force throttle: an IP over its failed-login budget is turned away with a
// 429 before its credentials are even checked. Paired with the basicAuth hooks
// below — a failed login counts, a successful one clears the penalty.
app.use(authThrottle);
const basicAuth = createBasicAuth(adminUsername, adminPassword, {
    onSuccess: noteAuthSuccess,
    onFailure: noteAuthFailure,
});
app.use(basicAuth);

// CSRF protection on all mutating requests, after auth + body parsing so the
// token from the form body is available. Safe (GET/HEAD) requests pass through.
app.use(csrfProtection);

// Records a state-changing admin action with the authenticated user and client
// IP. Best-effort — auditLog.record swallows its own write errors.
function audit(req, action, details) {
    recordAudit({ action, user: req.adminUser, ip: clientIp(req), details });
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function layout(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; background: #f5f6fa; color: #1a1f36; }
    .topbar { background: #1a1f36; color: #fff; padding: 20px 40px; display: flex; justify-content: space-between; align-items: center; }
    .topbar h1 { font-size: 18px; margin: 0; }
    .topbar nav a { color: #cbd5e1; text-decoration: none; margin-left: 20px; font-size: 13px; }
    .topbar nav a:hover { color: #fff; }
    .container { padding: 32px 40px; max-width: 900px; }
    .banner { background: #dcfce7; color: #166534; padding: 10px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
    .banner.info { background: #e0e7ff; color: #3730a3; }
    .banner.warn { background: #fef3c7; color: #92400e; }
    form.run-form { margin-bottom: 24px; }
    button { background: #4f46e5; color: #fff; border: none; padding: 10px 18px; border-radius: 6px; font-size: 14px; cursor: pointer; }
    button:hover { background: #4338ca; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
    th { background: #f9fafb; text-transform: uppercase; font-size: 11px; color: #6b7280; letter-spacing: 0.4px; }
    tr.failed td { color: #dc2626; }
    a { color: #4f46e5; text-decoration: none; }
    .empty { color: #6b7280; font-size: 14px; padding: 24px 0; }
    .card { background: #fff; border-radius: 8px; padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; }
    .card h2 { font-size: 15px; margin: 0 0 14px; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; margin-top: 14px; }
    label:first-child { margin-top: 0; }
    textarea, input[type=text], input[type=email], select { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; font-family: inherit; background: #fff; }
    textarea { min-height: 80px; }
    textarea.sql { min-height: 130px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; white-space: pre; }
    .hint { color: #6b7280; font-size: 12px; margin-top: 4px; }
    code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #eef2ff; color: #3730a3; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
    .checkbox-row label { margin: 0; }
    .metric { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px 18px; margin-bottom: 16px; background: #fafafa; }
    .metric h3 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; color: #6b7280; }
    .field-row { display: flex; gap: 16px; flex-wrap: wrap; }
    .field-row > div { flex: 1; min-width: 150px; }
    .errors { background: #fee2e2; color: #991b1b; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 13px; }
    .errors ul { margin: 6px 0 0; padding-left: 20px; }
    .errors li { margin: 2px 0; }
    .actions { display: flex; gap: 12px; align-items: center; margin-top: 4px; }
    .actions form { margin: 0; }
    button.secondary { background: #e5e7eb; color: #1a1f36; }
    button.secondary:hover { background: #d1d5db; }
    button:disabled { opacity: 0.6; cursor: default; }
    .status-row { font-size: 13px; color: #6b7280; margin-bottom: 20px; }
    .status-row strong { color: #1a1f36; }
    .review { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; font-size: 13px; color: #92400e; }
    .review strong { color: #78350f; }
    .review ul { margin: 8px 0 0; padding-left: 20px; }
    .review li { margin: 4px 0; }
    .review li.info { color: #6b7280; }
    .preview { font-size: 12px; color: #166534; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 6px 10px; margin: 8px 0 4px; }
    .preview.empty { color: #92400e; background: #fffbeb; border-color: #fde68a; }
    .omitted-note { font-size: 12px; color: #92400e; margin-top: 4px; }
    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; flex: none; }
    .dot.ok { background: #16a34a; } .dot.warn { background: #d97706; } .dot.error { background: #dc2626; }
    .health-row { display: flex; align-items: baseline; padding: 7px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    .health-row:last-child { border-bottom: none; }
    .health-name { font-weight: 600; min-width: 130px; }
    .health-detail { color: #6b7280; }
    .health-overall { font-size: 13px; font-weight: 500; color: #6b7280; }
</style>
</head>
<body>
<div class="topbar">
    <h1>Weekly Report Admin</h1>
    <nav><a href="/">Dashboard</a><a href="/configure">Configure</a><a href="/settings">Settings</a></nav>
</div>
<div class="container">${body}</div>
</body>
</html>`;
}

// Renders a run's metrics as a compact inline summary. Works for any metric set
// the active definition produced; falls back to the legacy three-field shape for
// runs recorded before the pipeline became metric-agnostic.
function renderMetricsSummary(run) {
    if (Array.isArray(run.metrics) && run.metrics.length > 0) {
        return run.metrics.map((m) => {
            const delta = (m.deltaPct === null || m.deltaPct === undefined)
                ? ''
                : ` (${m.deltaPct >= 0 ? '+' : ''}${m.deltaPct}%)`;
            return `${escapeHtml(m.label)}: ${escapeHtml(formatValue(m.value, m.format))}${escapeHtml(delta)}`;
        }).join(' &middot; ');
    }
    if (run.totalSales !== undefined) {
        return `Total Sales: $${Number(run.totalSales).toLocaleString('en-US', { minimumFractionDigits: 2 })} `
            + `&middot; New Signups: ${escapeHtml(run.newSignups)} &middot; Churn Rate: ${escapeHtml(run.churnRatePct)}%`;
    }
    return '&mdash;';
}

function renderDashboard(runs, settings, { banner, health } = {}) {
    const rows = runs.map((run) => {
        if (run.status === 'failed') {
            return `<tr class="failed">
                <td>${escapeHtml(new Date(run.runAt).toLocaleString('en-US'))}</td>
                <td colspan="2">Failed: ${escapeHtml(run.error)}</td>
                <td></td>
            </tr>`;
        }
        const sent = run.emailResult && run.emailResult.sent
            ? `Sent to ${run.emailResult.sent.length}${run.emailResult.failed?.length ? `, ${run.emailResult.failed.length} failed` : ''}`
            : `Not sent (${run.emailResult ? run.emailResult.reason : 'unknown'})`;
        const omitted = run.failedMetrics && run.failedMetrics.length
            ? `<div class="omitted-note">&#9888; ${run.failedMetrics.length} metric(s) omitted: ${escapeHtml(run.failedMetrics.map((f) => f.label || f.key).join(', '))}</div>`
            : '';
        return `<tr>
            <td>${escapeHtml(new Date(run.runAt).toLocaleString('en-US'))}</td>
            <td>${renderMetricsSummary(run)}${omitted}</td>
            <td>${escapeHtml(sent)}</td>
            <td><a href="/reports/${encodeURIComponent(run.filename)}" target="_blank">View PDF</a></td>
        </tr>`;
    }).join('');

    const bannerHtml = banner ? `<div class="banner ${escapeHtml(banner.type || '')}">${escapeHtml(banner.text)}</div>` : '';

    const statusLine = settings.testMode
        ? `<strong>Test mode is ON</strong> — all sends go to ${escapeHtml(settings.testModeEmail || '(SendGrid from-address)')} instead of the ${settings.recipients.length} configured recipient(s). <a href="/settings">Change</a>`
        : `Sending to <strong>${settings.recipients.length}</strong> recipient(s). <a href="/settings">Manage</a>`;

    const body = `
    ${bannerHtml}
    ${renderHealthPanel(health)}
    <div class="status-row">${statusLine}</div>
    <form class="run-form" method="POST" action="/run">
        ${csrfField()}
        <button type="submit">Run Report Now</button>
    </form>
    ${runs.length === 0
        ? '<div class="empty">No report runs yet. Click "Run Report Now" to generate the first one.</div>'
        : `<table>
            <thead><tr><th>Run Time</th><th>Metrics</th><th>Email</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`}
    `;

    return layout('Report Admin', body);
}

// The dashboard's live "System status" card. Same data as /status, rendered as
// coloured dots so an operator sees DB reachability, whether the scheduler is
// alive, and whether reports are going out — at a glance, behind the login.
const HEALTH_LABELS = {
    database: 'Database',
    definition: 'Report definition',
    scheduler: 'Scheduler',
    lastRun: 'Last run',
};

function renderHealthPanel(health) {
    if (!health) return '';
    const dotClass = (s) => (s === 'ok' ? 'ok' : s === 'error' ? 'error' : 'warn');
    const dot = (s) => `<span class="dot ${dotClass(s)}"></span>`;
    const rows = Object.entries(health.checks).map(([name, c]) =>
        `<div class="health-row">${dot(c.status)}<span class="health-name">${escapeHtml(HEALTH_LABELS[name] || name)}</span><span class="health-detail">${escapeHtml(c.detail || '')}</span></div>`
    ).join('');
    const overallText = health.status === 'ok'
        ? 'All systems operational'
        : health.status === 'degraded'
            ? 'Operational — needs attention'
            : 'Problem detected';
    return `<div class="card">
        <h2>System status ${dot(health.status)}<span class="health-overall">${escapeHtml(overallText)}</span></h2>
        ${rows}
        <div class="hint" style="margin-top: 10px;">Machine-readable at <code>/status</code> (JSON, no login required) — point an uptime monitor at it, or run <code>npm run healthcheck -- --alert</code> on a cron to get pushed a Slack/email alert if the scheduler dies.</div>
    </div>`;
}

function renderSettingsPage(settings, { saved = false, testResult = null, testTo = '' } = {}) {
    const testBanner = testResult
        ? `<div class="banner ${testResult.ok ? '' : 'warn'}">${escapeHtml(testResult.message)}</div>`
        : '';
    const body = `
    ${saved ? '<div class="banner">Settings saved.</div>' : ''}
    <div class="card">
        <h2>Recipients</h2>
        <form method="POST" action="/settings">
            ${csrfField()}
            <label for="recipients">Report recipients (one email per line, or comma-separated)</label>
            <textarea id="recipients" name="recipients">${escapeHtml(settings.recipients.join('\n'))}</textarea>
            <div class="hint">These are who the weekly report actually gets emailed to. Overrides REPORT_RECIPIENTS from .env once saved here.</div>

            <div class="checkbox-row">
                <input type="checkbox" id="testMode" name="testMode" ${settings.testMode ? 'checked' : ''}>
                <label for="testMode">Test mode — send every report only to the address below, ignoring the recipients above</label>
            </div>
            <label for="testModeEmail">Test mode address</label>
            <input type="email" id="testModeEmail" name="testModeEmail" value="${escapeHtml(settings.testModeEmail || '')}" placeholder="you@company.com">
            <div class="hint">Use this while testing changes so you never accidentally email real stakeholders.</div>

            <div style="margin-top: 20px;"><button type="submit">Save Settings</button></div>
        </form>
    </div>

    <div class="card">
        <h2>Verify email delivery</h2>
        ${testBanner}
        <form method="POST" action="/settings/test-email">
            ${csrfField()}
            <label for="testTo">Send a test email to</label>
            <input type="email" id="testTo" name="testTo" value="${escapeHtml(testTo)}" placeholder="you@company.com" required>
            <div class="hint">Sends a one-off test through SendGrid right now so you can confirm mail actually reaches an inbox — no need to wait for the weekly run. Uses the same API key and verified sender as the real report.</div>
            <div style="margin-top: 20px;"><button type="submit">Send test email</button></div>
        </form>
    </div>
    `;
    return layout('Report Admin — Settings', body);
}

app.get('/', async (req, res) => {
    let banner;
    if (req.query.ran === '1') banner = { type: '', text: 'Report run triggered — see the newest row below.' };
    if (req.query.ran === 'skipped') banner = { type: 'warn', text: 'A report run was already in progress, so this trigger was skipped.' };

    // Live health for the status panel. Best-effort: if the probe itself throws,
    // still render the dashboard (the panel is simply omitted) rather than 500.
    let health = null;
    try {
        health = await collectHealth();
    } catch (err) {
        logger.error('Dashboard health probe failed', { error: describeError(err) });
    }

    res.send(renderDashboard(readLog(), readSettings(), { banner, health }));
});

app.post('/run', async (req, res) => {
    audit(req, 'RUN_TRIGGERED');
    let ranParam = '1';
    try {
        const result = await runWeeklyReport();
        if (result.skipped) ranParam = 'skipped';
    } catch (err) {
        logger.error('Ad-hoc report run failed', { error: describeError(err) });
    }
    res.redirect(`/?ran=${ranParam}`);
});

app.get('/settings', (req, res) => {
    res.send(renderSettingsPage(readSettings()));
});

app.post('/settings', (req, res) => {
    const recipients = String(req.body.recipients || '')
        .split(/[\n,]/)
        .map((e) => e.trim())
        .filter(Boolean);
    const testMode = req.body.testMode === 'on';
    const testModeEmail = String(req.body.testModeEmail || '').trim() || null;

    writeSettings({ recipients, testMode, testModeEmail });
    logger.info('Settings updated from admin dashboard', { recipientCount: recipients.length, testMode });
    audit(req, 'SETTINGS_UPDATED', { recipientCount: recipients.length, testMode });

    res.send(renderSettingsPage(readSettings(), { saved: true }));
});

app.post('/settings/test-email', async (req, res) => {
    const testTo = String(req.body.testTo || '').trim();
    let testResult;
    try {
        testResult = await sendTestEmail({ to: testTo });
    } catch (err) {
        testResult = { ok: false, message: `Unexpected error sending test email: ${describeError(err)}` };
    }
    logger.info('Test email attempted from admin dashboard', { ok: testResult.ok, reason: testResult.reason });
    audit(req, 'TEST_EMAIL_SENT', { to: testTo, ok: testResult.ok });
    res.send(renderSettingsPage(readSettings(), { testResult, testTo }));
});

app.get('/reports/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.pdf')) return res.status(400).send('Invalid file');
    const filePath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Report not found');
    res.sendFile(filePath);
});

// ---- /configure : view, AI-regenerate, and save the report definition -----

// Renders one metric as a block of form fields keyed by its slot index.
// `pv` (optional) is this metric's { value, priorValue } from a dry-run — shown
// read-only so the reviewer sees the actual number the query returns.
function renderMetricFields(m, i, pv) {
    const fmt = (v) => (m.format === v ? 'selected' : '');
    const dmode = (v) => (m.deltaMode === v ? 'selected' : '');
    let previewHtml = '';
    if (pv && pv.value !== null && pv.value !== undefined) {
        let txt = `Returns ${formatValue(pv.value, m.format)}`;
        if (pv.priorValue !== null && pv.priorValue !== undefined) {
            const d = computeDelta(pv.value, pv.priorValue, m.deltaMode);
            txt += `, prior ${formatValue(pv.priorValue, m.format)} (${d >= 0 ? '+' : ''}${d}${m.deltaMode === 'absolute' ? '' : '%'})`;
        }
        previewHtml = `<div class="preview">↳ ${escapeHtml(txt)} — does that number look right?</div>`;
    } else if (pv) {
        previewHtml = '<div class="preview empty">↳ Returned no value when last run.</div>';
    }
    return `<div class="metric">
        <h3>Metric ${i + 1}</h3>
        <div class="field-row">
            <div><label>Key</label><input type="text" name="m${i}_key" value="${escapeHtml(m.key || '')}" placeholder="total_sales"></div>
            <div><label>Label</label><input type="text" name="m${i}_label" value="${escapeHtml(m.label || '')}" placeholder="Total Sales"></div>
        </div>
        <div class="field-row">
            <div><label>Format</label><select name="m${i}_format"><option value="number" ${fmt('number')}>number</option><option value="currency" ${fmt('currency')}>currency</option><option value="percent" ${fmt('percent')}>percent</option></select></div>
            <div><label>Delta mode</label><select name="m${i}_delta"><option value="relative" ${dmode('relative')}>relative (%)</option><option value="absolute" ${dmode('absolute')}>absolute (points)</option></select></div>
            <div class="checkbox-row" style="margin-top:32px;"><input type="checkbox" name="m${i}_invert" ${m.invertDelta ? 'checked' : ''}><label>lower is better</label></div>
        </div>
        <label>SQL</label>
        <textarea class="sql" name="m${i}_sql" placeholder="WITH ... SELECT ... AS value, ... AS prior_value">${escapeHtml(m.sql || '')}</textarea>
        ${previewHtml}
    </div>`;
}

// Renders the definition editor. `definition` is whatever should populate the
// form right now — the saved/demo definition on GET, or an unsaved AI proposal
// / a rejected submission on POST — so the user never loses their edits.
function renderConfigurePage(definition, { source, banner, errors = [], dropped = [], warnings = [], preview = { metrics: {} } } = {}) {
    const metrics = definition.metrics || [];
    const slotCount = metrics.length + 1; // one spare slot for adding a metric
    const previewMetrics = (preview && preview.metrics) || {};
    const metricCards = [];
    for (let i = 0; i < slotCount; i++) {
        const m = metrics[i] || {};
        metricCards.push(renderMetricFields(m, i, m.key ? previewMetrics[m.key] : undefined));
    }

    const trend = definition.trend || {};
    const columnsJson = trend.columns
        ? JSON.stringify(trend.columns, null, 2)
        : '[\n  { "key": "value", "label": "Value", "format": "number" }\n]';

    const bannerHtml = banner
        ? `<div class="banner ${escapeHtml(banner.type || '')}">${escapeHtml(banner.text)}</div>` : '';
    const errorsHtml = errors.length
        ? `<div class="errors"><strong>Not saved — fix these and try again:</strong><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : '';
    const droppedHtml = dropped.length
        ? `<div class="banner warn">The AI could not get these to validate, so they were left out: ${escapeHtml(dropped.map((d) => `${d.target} (${d.reason})`).join('; '))}</div>` : '';
    const warningsHtml = warnings.length
        ? `<div class="review"><strong>⚠ ${warnings.length} thing(s) worth a look before you save</strong> — advisory only; these queries run, but may not measure what you expect. You can still save.<ul>${
            warnings.map((w) => `<li class="${escapeHtml(w.level || 'info')}">${escapeHtml(w.message)}</li>`).join('')
        }</ul></div>` : '';

    let sourceLine;
    if (source === 'saved') sourceLine = 'Editing your <strong>saved</strong> report definition.';
    else if (source === 'demo') sourceLine = 'No saved definition yet — showing the built-in <strong>demo</strong> metrics. Save, or use &ldquo;Regenerate with AI&rdquo;, to make it yours.';
    else sourceLine = 'Reviewing an <strong>unsaved</strong> proposal — nothing is applied until you click &ldquo;Save definition&rdquo;.';

    const regenerate = isLlmConfigured()
        ? `<form method="POST" action="/configure/regenerate">
                ${csrfField()}
                <button type="submit" class="secondary">Regenerate with AI (~30s)</button>
           </form>`
        : '<span class="hint">Set GROQ_API_KEY (or LLM_BASE_URL + a compatible key) to enable &ldquo;Regenerate with AI&rdquo;.</span>';

    const body = `
    ${bannerHtml}
    ${errorsHtml}
    ${droppedHtml}
    ${warningsHtml}
    <div class="status-row">${sourceLine}</div>
    <p class="hint" style="max-width:660px; margin-top:-12px; line-height:1.5;">
        Each metric's SQL must return one row with a <code>value</code> column (and optionally <code>prior_value</code> for the week-over-week delta).
        <code>$1</code> is the as-of timestamp. On save, every query is run read-only against your database — one that writes, errors, or returns the wrong shape is rejected.
        Validation confirms a query <em>runs and returns the right shape</em>, not that it measures the right thing — that part is your call.
    </p>
    <form method="POST" action="/configure">
        ${csrfField()}
        <input type="hidden" name="metric_slots" value="${slotCount}">
        <div class="card">
            <h2>Metrics</h2>
            ${metricCards.join('')}
            <div class="hint">The last (empty) block is a spare — fill it in to add a metric, or leave it blank. To remove a metric, clear its key and SQL.</div>
        </div>
        <div class="card">
            <h2>Trend chart</h2>
            <div class="checkbox-row">
                <input type="checkbox" id="trend_enabled" name="trend_enabled" ${definition.trend ? 'checked' : ''}>
                <label for="trend_enabled">Include a trend chart</label>
            </div>
            <label>Title</label>
            <input type="text" name="trend_title" value="${escapeHtml(trend.title || '')}" placeholder="Daily Revenue — Last 7 Days">
            <div class="field-row">
                <div>
                    <label>Chart type</label>
                    <select name="trend_chartType"><option value="bar" ${trend.chartType === 'bar' ? 'selected' : ''}>bar</option><option value="line" ${trend.chartType === 'line' ? 'selected' : ''}>line</option></select>
                </div>
                <div>
                    <label>Series to plot (a column key below)</label>
                    <input type="text" name="trend_chartSeries" value="${escapeHtml(trend.chartSeries || '')}" placeholder="sales">
                </div>
            </div>
            <label>Columns (JSON array of <code>{ "key", "label", "format" }</code>)</label>
            <textarea class="sql" name="trend_columns">${escapeHtml(columnsJson)}</textarea>
            <label>Trend SQL (one row per day: a <code>label</code> column plus one column per key above)</label>
            <textarea class="sql" name="trend_sql" placeholder="SELECT to_char(day,'Mon DD') AS label, ...">${escapeHtml(trend.sql || '')}</textarea>
        </div>
        <div class="actions">
            <button type="submit">Save definition</button>
            ${regenerate}
        </div>
    </form>
    `;
    return layout('Report Admin — Configure', body);
}

// Reconstructs a candidate definition from the posted form fields. Empty spare
// metric slots are skipped. Returns the parsed definition plus a parse error for
// the trend columns JSON (surfaced as a validation error rather than a crash).
function parseDefinitionFromForm(body) {
    const slots = Number(body.metric_slots) || 0;
    const metrics = [];
    for (let i = 0; i < slots; i++) {
        const key = (body[`m${i}_key`] || '').trim();
        const sql = (body[`m${i}_sql`] || '').trim();
        if (!key && !sql) continue; // an untouched spare slot
        metrics.push({
            key,
            label: (body[`m${i}_label`] || '').trim(),
            format: body[`m${i}_format`] || 'number',
            invertDelta: body[`m${i}_invert`] === 'on',
            deltaMode: body[`m${i}_delta`] === 'absolute' ? 'absolute' : 'relative',
            sql,
        });
    }

    let trend = null;
    let trendColumnsError = null;
    if (body.trend_enabled === 'on') {
        let columns = [];
        try {
            const parsed = JSON.parse(body.trend_columns || '[]');
            if (!Array.isArray(parsed)) throw new Error('not an array');
            columns = parsed;
        } catch {
            trendColumnsError = 'Trend "columns" must be a valid JSON array, e.g. [{ "key": "sales", "label": "Sales", "format": "currency" }].';
        }
        trend = {
            title: (body.trend_title || '').trim(),
            chartType: body.trend_chartType === 'line' ? 'line' : 'bar',
            chartSeries: (body.trend_chartSeries || '').trim(),
            columns,
            sql: (body.trend_sql || '').trim(),
        };
    }
    return { definition: { version: 1, source: 'custom', metrics, trend }, trendColumnsError };
}

// Runs every query in a candidate definition read-only against the live DB and
// returns any shape/execution problems — the same gate `npm run setup` applies,
// so a hand-edit can't persist a query that doesn't run. Also returns the sampled
// values (keyed by metric key) so the caller can preview + lint the real numbers.
async function validateDefinitionLive(definition) {
    const errors = [];
    const values = {};
    const asOf = new Date();
    for (const m of definition.metrics) {
        try {
            const { rows } = await runReadOnly(m.sql, [asOf]);
            if (rows && rows[0]) values[m.key] = rows[0];
            const res = checkMetricShape(rows);
            if (!res.ok) errors.push(`metric "${m.key || '(no key)'}": ${res.reason}`);
        } catch (err) {
            errors.push(`metric "${m.key || '(no key)'}": ${describeError(err)}`);
        }
    }
    if (definition.trend) {
        try {
            const { rows } = await runReadOnly(definition.trend.sql, [asOf]);
            const res = checkTrendShape(rows, definition.trend.columns);
            if (!res.ok) errors.push(`trend: ${res.reason}`);
        } catch (err) {
            errors.push(`trend: ${describeError(err)}`);
        }
    }
    return { errors, values };
}

app.get('/configure', (req, res) => {
    const { definition, source } = getReportDefinition();
    let banner;
    if (req.query.saved === '1') {
        banner = { type: '', text: 'Report definition saved. The next report run will use these metrics.' };
    }
    res.send(renderConfigurePage(definition, { source, banner }));
});

app.post('/configure', async (req, res) => {
    const { definition, trendColumnsError } = parseDefinitionFromForm(req.body);
    const errors = [];
    if (trendColumnsError) errors.push(trendColumnsError);

    // Structural checks first (cheap), then live shape/exec validation (needs the DB).
    let liveValues = {};
    errors.push(...validateDefinition(definition));
    if (errors.length === 0) {
        try {
            const live = await validateDefinitionLive(definition);
            errors.push(...live.errors);
            liveValues = live.values;
        } catch (err) {
            errors.push(`Could not reach the database to validate the queries: ${describeError(err)}`);
        }
    }

    if (errors.length > 0) {
        // Re-render with the submitted values so the user's edits aren't lost.
        res.status(400).send(renderConfigurePage(definition, { source: 'custom', errors }));
        return;
    }

    try {
        saveReportDefinition(definition);
        logger.info('Report definition saved from admin /configure', { metricCount: definition.metrics.length });
        audit(req, 'DEFINITION_SAVED', { metricCount: definition.metrics.length });
    } catch (err) {
        res.status(400).send(renderConfigurePage(definition, { source: 'custom', errors: [describeError(err)] }));
        return;
    }

    // Saved successfully. Advisory semantic review of what was just saved — if
    // anything looks off (an all-time query, a percent out of range, a
    // format/label mismatch), show it right here so the operator can fix it in a
    // follow-up edit. Never blocks the save; re-saving the same definition is
    // idempotent, so re-rendering (instead of the usual PRG redirect) is safe.
    const warnings = lintDefinition(definition, { values: liveValues });
    if (warnings.length > 0) {
        res.status(200).send(renderConfigurePage(definition, {
            source: 'saved',
            banner: { type: 'info', text: 'Saved — the next run uses these metrics. A few advisory notes below; nothing needs fixing to run.' },
            warnings,
            preview: buildPreview(definition, liveValues),
        }));
        return;
    }
    res.redirect('/configure?saved=1');
});

app.post('/configure/regenerate', async (req, res) => {
    if (!isLlmConfigured()) {
        const { definition, source } = getReportDefinition();
        res.status(400).send(renderConfigurePage(definition, {
            source,
            banner: { type: 'warn', text: 'GROQ_API_KEY is not set, so the AI generator is unavailable. Set it in .env and restart the admin server.' },
        }));
        return;
    }
    try {
        const { definition, dropped, warnings, preview } = await generateReportDefinition({
            onProgress: (p) => logger.info('AI report generation', p),
        });
        audit(req, 'DEFINITION_REGENERATED', { metricCount: definition.metrics.length, dropped: dropped.length, warnings: warnings.length });
        res.send(renderConfigurePage(definition, {
            source: 'proposal',
            dropped,
            warnings,
            preview,
            banner: {
                type: 'info',
                text: `AI proposed ${definition.metrics.length} metric(s)${definition.trend ? ' and a trend chart' : ''}. Review the returned values and any flags below, then click “Save definition” to apply — nothing is saved yet.`,
            },
        }));
    } catch (err) {
        logger.error('AI report generation failed from admin /configure', { error: describeError(err) });
        const { definition, source } = getReportDefinition();
        res.status(500).send(renderConfigurePage(definition, {
            source,
            banner: { type: 'warn', text: `AI generation failed: ${describeError(err)}` },
        }));
    }
});

app.listen(PORT, () => {
    logger.info(`Admin dashboard running at http://localhost:${PORT}`);
    if (!adminUsername || !adminPassword) {
        logger.warn('ADMIN_USERNAME/ADMIN_PASSWORD not set — the dashboard is running WITHOUT authentication. '
            + 'Anyone who can reach this port can trigger report generation and download archived PDFs. '
            + 'Set both in .env before exposing this beyond localhost.');
    }
});
