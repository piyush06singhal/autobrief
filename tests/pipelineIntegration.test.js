// Blank the LLM key BEFORE anything requires config/env, so this test always
// takes the deterministic templated-summary path and never makes a network call
// — regardless of whatever GROQ_API_KEY the ambient .env happens to carry.
// (env.js reads process.env at load, and dotenv won't override an already-set
// var, so setting it here wins. node --test runs each file in its own process,
// so this can't leak into other suites.)
process.env.GROQ_API_KEY = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getWeeklyMetrics, closePool } = require('../src/db');
const { generateExecutiveSummary } = require('../src/ai/summary');
const { renderReportHtml } = require('../src/render/renderHtml');
const { renderPdfFromHtml } = require('../src/render/renderPdf');

// Full-pipeline integration test: a real Postgres (seeded with db/init.sql) ->
// metric aggregation -> executive summary -> HTML render -> a real headless-Chrome
// PDF. It exercises the glue that the unit tests can't: those stub the database
// and the browser, so nothing else proves the whole chain actually turns a live
// database into a valid PDF.
//
// Hermetic by construction — no external paid services are touched:
//   * LLM  — GROQ_API_KEY is blanked above, so the summary uses the templated
//            fallback (deterministic, offline).
//   * email — the chain stops at the PDF buffer; the SendGrid send is never called.
//   * files — everything is read-only / in-memory; nothing is written to the
//            shared output/ volume (no archived PDF, no run-log mutation).
//
// Gated on RUN_DB_TESTS=1 with DATABASE_URL pointing at a reachable, seeded
// Postgres, matching tests/safeQueryLive.test.js. Run it with `npm run test:db`
// (locally against `npm run db:up`) or in CI (.github/workflows/ci.yml).
const DB_TESTS = process.env.RUN_DB_TESTS === '1';

const asOf = new Date();
let metrics;
let summary;
let html;

before(async () => {
    if (!DB_TESTS) return;
    metrics = await getWeeklyMetrics(asOf);
    summary = await generateExecutiveSummary(metrics);
    html = renderReportHtml({ metrics, executiveSummary: summary });
});

after(async () => {
    if (!DB_TESTS) return;
    await closePool();
});

test('getWeeklyMetrics returns the generic metric shape from a real database', { skip: !DB_TESTS }, () => {
    assert.equal(typeof metrics.asOf, 'string');
    assert.ok(Array.isArray(metrics.metrics) && metrics.metrics.length >= 1, 'at least one metric ran');
    assert.ok(Array.isArray(metrics.failedMetrics), 'failedMetrics is always an array');

    for (const m of metrics.metrics) {
        assert.ok(m.key && m.label, `metric carries a key and label: ${JSON.stringify(m)}`);
        assert.ok(Number.isFinite(m.value), `${m.key} value is a finite number, got ${m.value}`);
        assert.ok(['currency', 'number', 'percent'].includes(m.format), `${m.key} has a known format (${m.format})`);
    }

    // The shipped demo definition's three metrics must all have executed against
    // the seeded users/orders tables — none silently dropped.
    const keys = metrics.metrics.map((m) => m.key);
    for (const expected of ['total_sales', 'new_signups', 'churn_rate']) {
        assert.ok(
            keys.includes(expected),
            `demo metric "${expected}" ran (failed: ${JSON.stringify(metrics.failedMetrics)})`,
        );
    }
});

test('the executive summary falls back deterministically and names the metrics', { skip: !DB_TESTS }, () => {
    assert.equal(typeof summary, 'string');
    assert.ok(summary.length > 0, 'summary is non-empty');
    // With no LLM key, generateExecutiveSummary() must use the templated fallback,
    // which starts "This week —" and lists the metric labels.
    assert.match(summary, /^This week —/, `expected the fallback summary, got: ${summary}`);
    assert.ok(summary.includes(metrics.metrics[0].label), 'summary mentions a metric label');
});

test('the report renders to a full HTML document showing every metric', { skip: !DB_TESTS }, () => {
    assert.ok(/<html|<!doctype html/i.test(html), 'renders a full HTML document');
    for (const m of metrics.metrics) {
        assert.ok(html.includes(m.label), `HTML shows the "${m.label}" card`);
    }
});

test('the rendered HTML prints to a valid PDF via headless Chrome', { skip: !DB_TESTS }, async (t) => {
    let pdf;
    try {
        pdf = await renderPdfFromHtml(html);
    } catch (err) {
        // An environment with no usable Chrome (a dev box that never installed
        // it) skips rather than fails — CI installs Chrome, so it runs there.
        if (/failed to launch/i.test(err.message)) {
            return t.skip(`headless Chrome unavailable here: ${err.message}`);
        }
        throw err;
    }
    assert.ok(Buffer.isBuffer(pdf), 'returns a Node Buffer');
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'starts with the PDF magic header');
    assert.ok(pdf.length > 1000, `PDF is non-trivial in size (got ${pdf.length} bytes)`);
});
