const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluateScheduler,
    evaluateLastRun,
    evaluateDefinition,
    deriveStatus,
    describeAge,
    HEARTBEAT_STALE_MS,
} = require('../src/utils/health');

const NOW = new Date('2026-09-02T12:00:00Z');

// ---- scheduler liveness (the dead-scheduler detector) ----

test('scheduler: a missing heartbeat is a warning, not an error (may be manual-only)', () => {
    const r = evaluateScheduler({ now: NOW, heartbeatMtimeMs: null });
    assert.equal(r.status, 'warn');
    assert.equal(r.running, false);
});

test('scheduler: a fresh heartbeat is ok', () => {
    const r = evaluateScheduler({ now: NOW, heartbeatMtimeMs: NOW.getTime() - 5000 });
    assert.equal(r.status, 'ok');
    assert.equal(r.running, true);
    assert.equal(r.ageSeconds, 5);
});

test('scheduler: a heartbeat older than the stale window is an error (looks dead)', () => {
    const r = evaluateScheduler({ now: NOW, heartbeatMtimeMs: NOW.getTime() - (HEARTBEAT_STALE_MS + 60000) });
    assert.equal(r.status, 'error');
    assert.equal(r.running, false);
    assert.match(r.detail, /hung or dead/);
});

test('scheduler: right at the stale boundary is still ok, just past it is an error', () => {
    const justFresh = evaluateScheduler({ now: NOW, heartbeatMtimeMs: NOW.getTime() - HEARTBEAT_STALE_MS });
    assert.equal(justFresh.status, 'ok');
    const justStale = evaluateScheduler({ now: NOW, heartbeatMtimeMs: NOW.getTime() - (HEARTBEAT_STALE_MS + 1) });
    assert.equal(justStale.status, 'error');
});

// ---- last-run health (are reports actually going out) ----

test('lastRun: no runs recorded yet is a warning', () => {
    const r = evaluateLastRun({ now: NOW, entries: [] });
    assert.equal(r.status, 'warn');
});

test('lastRun: a successful most-recent run is ok and reports its age', () => {
    const entries = [
        { runAt: '2026-09-01T08:00:00Z', status: 'success' },
        { runAt: '2026-08-25T08:00:00Z', status: 'success' },
    ];
    const r = evaluateLastRun({ now: NOW, entries });
    assert.equal(r.status, 'ok');
    assert.equal(r.lastStatus, 'success');
    assert.equal(r.lastSuccessAt, '2026-09-01T08:00:00Z');
    assert.equal(r.ageSeconds, Math.round((NOW - new Date('2026-09-01T08:00:00Z')) / 1000));
});

test('lastRun: a failed most-recent run is a warning (alert already fired) and still finds the last success', () => {
    const entries = [
        { runAt: '2026-09-01T08:00:00Z', status: 'failed', error: 'boom' },
        { runAt: '2026-08-25T08:00:00Z', status: 'success' },
    ];
    const r = evaluateLastRun({ now: NOW, entries });
    assert.equal(r.status, 'warn');
    assert.equal(r.lastStatus, 'failed');
    assert.equal(r.lastSuccessAt, '2026-08-25T08:00:00Z');
    // The unauthenticated /status payload must not echo the raw run error.
    assert.doesNotMatch(r.detail, /boom/);
});

// ---- definition health ----

test('definition: the built-in demo metrics are a warning nudging setup', () => {
    const r = evaluateDefinition({ definition: { metrics: [{}, {}] }, source: 'demo' });
    assert.equal(r.status, 'warn');
    assert.equal(r.metricCount, 2);
    assert.match(r.detail, /npm run setup/);
});

test('definition: a saved definition is ok', () => {
    const r = evaluateDefinition({ definition: { metrics: [{}, {}, {}] }, source: 'saved' });
    assert.equal(r.status, 'ok');
    assert.equal(r.metricCount, 3);
});

test('definition: a load error is an error', () => {
    const r = evaluateDefinition({ error: new Error('bad json') });
    assert.equal(r.status, 'error');
    assert.match(r.detail, /could not be loaded/);
});

// ---- overall status is worst-of ----

test('deriveStatus: all ok -> ok', () => {
    assert.equal(deriveStatus({ a: { status: 'ok' }, b: { status: 'ok' } }), 'ok');
});

test('deriveStatus: any warn (no error) -> degraded', () => {
    assert.equal(deriveStatus({ a: { status: 'ok' }, b: { status: 'warn' } }), 'degraded');
});

test('deriveStatus: any error wins over warn -> error', () => {
    assert.equal(deriveStatus({ a: { status: 'warn' }, b: { status: 'error' }, c: { status: 'ok' } }), 'error');
});

// ---- age humanizer ----

test('describeAge: coarse buckets and unknown', () => {
    assert.equal(describeAge(null), 'at an unknown time');
    assert.equal(describeAge(10), 'moments ago');
    assert.equal(describeAge(60 * 60), '60 minutes ago'); // below the 90-minute cutover
    assert.equal(describeAge(60 * 60 * 5), '5 hours ago');
    assert.equal(describeAge(86400 * 2), '2 days ago');
    assert.equal(describeAge(86400 * 3), '3 days ago');
});
