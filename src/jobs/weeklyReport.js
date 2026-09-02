const fs = require('fs');
const path = require('path');
const { getWeeklyMetrics, closePool } = require('../db');
const { generateExecutiveSummary } = require('../ai/summary');
const { renderReportHtml } = require('../render/renderHtml');
const { renderPdfFromHtml } = require('../render/renderPdf');
const { sendReportEmail } = require('../email/sendgrid');
const { appendRun } = require('./runLog');
const { cleanupOldReports } = require('./retention');
const { withRetry } = require('../utils/retry');
const { sendFailureAlert } = require('../utils/alert');
const { describeError } = require('../utils/describeError');
const { acquireLock, releaseLock } = require('../utils/lock');
const { reportTimezone } = require('../config/env');
const logger = require('../utils/logger');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');

// Runs the full pipeline once: query metrics -> AI summary -> render -> PDF -> email -> archive.
// The scheduler (cron) and admin dashboard (manual trigger) run as separate
// processes/containers, so a lock file in the shared output/ volume stops
// them from ever running the pipeline at the same time.
async function runWeeklyReport({ asOf = new Date() } = {}) {
    if (!acquireLock()) {
        logger.warn('Another report run is already in progress — skipping this trigger.');
        return { skipped: true };
    }

    try {
        return await runWeeklyReportInner({ asOf });
    } finally {
        releaseLock();
    }
}

async function runWeeklyReportInner({ asOf }) {
    const started = Date.now();
    logger.info('Weekly report job started', { asOf: asOf.toISOString() });

    try {
        const metrics = await withRetry(() => getWeeklyMetrics(asOf), {
            retries: 1, delayMs: 2000, label: 'Metrics query',
        });
        // Generic across whatever metric set the active definition produced.
        logger.info('Metrics aggregated', {
            metricCount: metrics.metrics.length,
            values: metrics.metrics.map((m) => `${m.key}=${m.value}`).join(', '),
        });

        const executiveSummary = await generateExecutiveSummary(metrics);
        const html = renderReportHtml({ metrics, executiveSummary });
        // Retry once: a Chrome crash/OOM mid-render is often transient, and a
        // fresh relaunch usually succeeds. Each attempt launches its own browser.
        const pdfBuffer = await withRetry(() => renderPdfFromHtml(html), {
            retries: 1, delayMs: 2000, label: 'PDF render',
        });

        const dateStamp = asOf.toISOString().slice(0, 10);
        const timeStamp = asOf.toISOString().slice(11, 19).replace(/:/g, '');
        const filename = `weekly-report-${dateStamp}-${timeStamp}.pdf`;

        if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUTPUT_DIR, filename), pdfBuffer);
        logger.info('PDF archived', { path: path.join('output', filename) });

        const periodLabel = new Date(metrics.asOf).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric', timeZone: reportTimezone,
        });
        const emailResult = await sendReportEmail({ pdfBuffer, periodLabel, filename });

        const durationMs = Date.now() - started;
        logger.info('Weekly report job finished', { durationMs, emailResult });

        appendRun({
            runAt: new Date().toISOString(),
            asOf: metrics.asOf,
            filename,
            // A compact snapshot of every metric, so the admin history can show
            // whatever set this company's definition produces (not just the
            // original sales/signups/churn three).
            metrics: metrics.metrics.map((m) => ({
                key: m.key, label: m.label, value: m.value, format: m.format, deltaPct: m.deltaPct,
            })),
            // Recorded when a metric query failed and was dropped, so the
            // dashboard history shows a report went out incomplete rather than
            // that only being buried in the container logs.
            ...(metrics.failedMetrics && metrics.failedMetrics.length
                ? { failedMetrics: metrics.failedMetrics }
                : {}),
            emailResult,
            durationMs,
            status: 'success',
        });

        cleanupOldReports();

        return { metrics, filename, emailResult, durationMs };
    } catch (err) {
        const errorMessage = describeError(err);
        logger.error('Weekly report job failed', { error: errorMessage, stack: err.stack });
        appendRun({
            runAt: new Date().toISOString(),
            asOf: asOf.toISOString(),
            status: 'failed',
            error: errorMessage,
        });
        await sendFailureAlert({ error: errorMessage, asOf: asOf.toISOString() });
        throw err;
    }
}

module.exports = { runWeeklyReport, closePool };
