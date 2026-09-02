const fs = require('fs');
const path = require('path');
const { runReadOnly } = require('../db/safeQuery');
const { getReportDefinition } = require('../config/reportDefinition');
const { readLog } = require('../jobs/runLog');
const { describeError } = require('./describeError');
const logger = require('./logger');

// Canonical scheduler heartbeat file. Owned here — not in scheduler.js — so the
// writer (the scheduler process) and the reader (this health check, the admin
// /status endpoint, Docker's healthcheck) can never drift apart on the path.
// The scheduler touches it every HEARTBEAT_INTERVAL_MS; a stale mtime is the
// signal that the scheduler process is hung or dead.
const HEARTBEAT_PATH = path.join(__dirname, '..', '..', 'output', '.scheduler-heartbeat');
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
// Fresh means "touched within 2.5 write intervals" — tolerates one missed tick
// (GC pause, brief I/O stall) without a false "scheduler dead" alarm.
const HEARTBEAT_STALE_MS = 150 * 1000;

function writeHeartbeat() {
    const dir = path.dirname(HEARTBEAT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HEARTBEAT_PATH, new Date().toISOString());
}

// Small humanizer for "last run succeeded N ago" — kept coarse on purpose; this
// is a status line, not a precise duration.
function describeAge(ageSeconds) {
    if (ageSeconds == null || Number.isNaN(ageSeconds)) return 'at an unknown time';
    if (ageSeconds < 90) return 'moments ago';
    const mins = Math.round(ageSeconds / 60);
    if (mins < 90) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.round(ageSeconds / 3600);
    if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(ageSeconds / 86400);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---- Pure evaluators (no I/O) — the logic that unit tests pin down. ----

// Turns a heartbeat file mtime into a scheduler-liveness verdict.
//   missing  -> warn  (may be a manual-only deployment, or never started)
//   stale    -> error (it ran at some point and stopped: reports won't fire)
//   fresh    -> ok
function evaluateScheduler({ now = new Date(), heartbeatMtimeMs = null } = {}) {
    if (heartbeatMtimeMs == null) {
        return {
            status: 'warn',
            running: false,
            detail: 'No scheduler heartbeat found — the scheduler container may not be running '
                + '(expected if you only trigger runs manually from the dashboard).',
        };
    }
    const ageMs = now.getTime() - heartbeatMtimeMs;
    const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
    if (ageMs > HEARTBEAT_STALE_MS) {
        return {
            status: 'error',
            running: false,
            ageSeconds,
            detail: `Scheduler heartbeat is stale (${ageSeconds}s old; fresh is < ${HEARTBEAT_STALE_MS / 1000}s). `
                + 'The scheduler process looks hung or dead — the weekly report will not fire until it is restarted.',
        };
    }
    return {
        status: 'ok',
        running: true,
        ageSeconds,
        detail: `Scheduler is alive (heartbeat ${ageSeconds}s ago).`,
    };
}

// Turns the run-log into a "are reports actually going out" verdict. Keyed on the
// most recent run's status rather than on a guessed cadence, so it never false-
// alarms for a non-weekly REPORT_CRON. A past failure is 'warn' (an alert already
// fired at the time), not 'error' — the system itself is still healthy.
function evaluateLastRun({ now = new Date(), entries = [] } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
        return { status: 'warn', detail: 'No report runs recorded yet.' };
    }
    const last = entries[0]; // runLog stores newest-first
    const ageMs = now.getTime() - new Date(last.runAt).getTime();
    const ageSeconds = Number.isNaN(ageMs) ? null : Math.max(0, Math.round(ageMs / 1000));
    const lastSuccess = entries.find((e) => e.status === 'success');
    const base = {
        lastRunAt: last.runAt || null,
        lastStatus: last.status || 'unknown',
        ageSeconds,
        lastSuccessAt: lastSuccess ? lastSuccess.runAt : null,
    };
    if (last.status === 'failed') {
        return {
            ...base,
            status: 'warn',
            detail: 'The most recent report run failed (a failure alert was sent at the time; '
                + 'see the dashboard and container logs for the error).',
        };
    }
    return { ...base, status: 'ok', detail: `Last report run succeeded ${describeAge(ageSeconds)}.` };
}

// Turns the active report definition into a verdict. The built-in demo metrics
// are 'warn' (functional, but not this company's real metrics yet).
function evaluateDefinition({ definition, source, error } = {}) {
    if (error) {
        return { status: 'error', detail: `Report definition could not be loaded: ${describeError(error)}` };
    }
    const metricCount = definition && Array.isArray(definition.metrics) ? definition.metrics.length : 0;
    if (source === 'demo') {
        return {
            status: 'warn',
            source,
            metricCount,
            detail: `Running the built-in DEMO metrics (${metricCount}). `
                + 'Run `npm run setup` to generate metrics for your own database.',
        };
    }
    return {
        status: 'ok',
        source,
        metricCount,
        detail: `Using the saved report definition (${metricCount} metric${metricCount === 1 ? '' : 's'}).`,
    };
}

// Overall status: worst-of. Any error -> error; any warn -> degraded; else ok.
function deriveStatus(checks) {
    const statuses = Object.values(checks).map((c) => c && c.status);
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('warn')) return 'degraded';
    return 'ok';
}

// ---- I/O probes: wire the pure evaluators to real sources. ----

async function probeDatabase() {
    const started = Date.now();
    try {
        // A trivial read confirms the pool can connect AND run a statement inside
        // the read-only transaction. Short timeout so a hung DB can't hang /status
        // (the pool's connectionTimeoutMillis also bounds an unreachable host).
        await runReadOnly('SELECT 1 AS ok', [], { timeoutMs: 5000 });
        const latencyMs = Date.now() - started;
        return { status: 'ok', latencyMs, detail: `Database reachable (${latencyMs}ms).` };
    } catch (err) {
        logger.error('Health check: database probe failed', { error: describeError(err) });
        return { status: 'error', detail: `Database unreachable: ${describeError(err)}` };
    }
}

function probeScheduler(now) {
    let heartbeatMtimeMs = null;
    try {
        heartbeatMtimeMs = fs.statSync(HEARTBEAT_PATH).mtimeMs;
    } catch {
        heartbeatMtimeMs = null; // file absent -> evaluated as "not running"
    }
    return evaluateScheduler({ now, heartbeatMtimeMs });
}

function probeDefinition() {
    try {
        const { definition, source } = getReportDefinition();
        return evaluateDefinition({ definition, source });
    } catch (err) {
        return evaluateDefinition({ error: err });
    }
}

function probeLastRun(now) {
    let entries = [];
    try {
        entries = readLog();
    } catch {
        entries = [];
    }
    return evaluateLastRun({ now, entries });
}

// The single entry point used by the admin /status endpoint, the dashboard
// panel, and scripts/healthcheck.js. Returns a machine-readable snapshot with a
// worst-of overall status and per-check detail.
async function collectHealth({ now = new Date() } = {}) {
    const database = await probeDatabase();
    const checks = {
        database,
        definition: probeDefinition(),
        scheduler: probeScheduler(now),
        lastRun: probeLastRun(now),
    };
    return { status: deriveStatus(checks), checkedAt: now.toISOString(), checks };
}

module.exports = {
    collectHealth,
    writeHeartbeat,
    HEARTBEAT_PATH,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_STALE_MS,
    // exported for unit tests
    evaluateScheduler,
    evaluateLastRun,
    evaluateDefinition,
    deriveStatus,
    describeAge,
};
