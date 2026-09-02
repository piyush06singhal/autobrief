const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lintDefinition, buildPreview, referencesAsOf } = require('../src/ai/lintDefinition');

// A minimal valid metric the individual tests tweak one field at a time.
function metric(over = {}) {
    return {
        key: 'm', label: 'Total Sales', format: 'currency', invertDelta: false,
        deltaMode: 'relative', sql: "SELECT sum(amount) AS value FROM orders WHERE created_at >= $1::timestamptz - INTERVAL '7 days'",
        ...over,
    };
}
function codes(warnings) { return warnings.map((w) => w.code); }

// ---- referencesAsOf ----

test('referencesAsOf detects $1 (and not $10 as a false match on the boundary)', () => {
    assert.equal(referencesAsOf('SELECT 1 WHERE t >= $1'), true);
    assert.equal(referencesAsOf('SELECT 1'), false);
    assert.equal(referencesAsOf('SELECT $10'), false); // \b after $1 must fail on $10
});

// ---- the headline check: a "weekly" metric that isn't time-bounded ----

test('lintDefinition flags a metric whose SQL never references $1', () => {
    const w = lintDefinition({ metrics: [metric({ sql: 'SELECT sum(amount) AS value FROM orders' })] });
    assert.ok(codes(w).includes('not_time_bounded'));
    assert.equal(w[0].level, 'warn');
});

test('lintDefinition does not flag a properly time-bounded metric', () => {
    const w = lintDefinition({ metrics: [metric()] });
    assert.equal(w.length, 0);
});

test('lintDefinition flags a trend whose SQL never references $1', () => {
    const w = lintDefinition({ metrics: [metric()], trend: { sql: 'SELECT day AS label, n AS value FROM daily' } });
    assert.deepEqual(codes(w), ['not_time_bounded']);
    assert.equal(w[0].target, 'trend');
});

// ---- value-based checks (need the sampled dry-run row) ----

test('percent metric returning a value outside 0-100 is flagged as a likely raw count', () => {
    const def = { metrics: [metric({ key: 'cr', label: 'Conversion Rate', format: 'percent', sql: 'SELECT count(*) AS value FROM x WHERE t >= $1' })] };
    const w = lintDefinition(def, { values: { cr: { value: '4201' } } });
    assert.ok(codes(w).includes('percent_range'));
});

test('percent metric within 0-100 is not flagged', () => {
    const def = { metrics: [metric({ key: 'cr', label: 'Conversion Rate', format: 'percent', sql: 'SELECT 3.2 AS value WHERE t >= $1' })] };
    const w = lintDefinition(def, { values: { cr: { value: '3.2' } } });
    assert.equal(w.length, 0);
});

test('value exactly equal to prior_value (nonzero) is flagged, zero is not', () => {
    const eq = lintDefinition({ metrics: [metric()] }, { values: { m: { value: '100', prior_value: '100' } } });
    assert.ok(codes(eq).includes('value_equals_prior'));
    const zero = lintDefinition({ metrics: [metric()] }, { values: { m: { value: '0', prior_value: '0' } } });
    assert.ok(!codes(zero).includes('value_equals_prior'));
    const diff = lintDefinition({ metrics: [metric()] }, { values: { m: { value: '100', prior_value: '90' } } });
    assert.ok(!codes(diff).includes('value_equals_prior'));
});

// ---- metadata / label sanity ----

test('monetary label with a non-currency format is flagged (info)', () => {
    const w = lintDefinition({ metrics: [metric({ label: 'Weekly Revenue', format: 'number' })] });
    const hit = w.find((x) => x.code === 'format_currency');
    assert.ok(hit);
    assert.equal(hit.level, 'info');
});

test('count-like label with a currency format is flagged (info)', () => {
    const w = lintDefinition({ metrics: [metric({ label: 'New Signups', format: 'currency' })] });
    assert.ok(codes(w).includes('format_count'));
});

test('a lower-is-better label without invertDelta is flagged', () => {
    const w = lintDefinition({ metrics: [metric({ label: 'Weekly Churn', format: 'percent', invertDelta: false })] });
    assert.ok(codes(w).includes('invert_delta'));
    // and NOT flagged once invertDelta is set correctly
    const ok = lintDefinition({ metrics: [metric({ label: 'Weekly Churn', format: 'percent', invertDelta: true, sql: 'SELECT 2.1 AS value WHERE t >= $1' })] }, { values: { m: { value: '2.1' } } });
    assert.ok(!codes(ok).includes('invert_delta'));
});

// ---- buildPreview ----

test('buildPreview coerces string numerics and nulls, keyed by metric key', () => {
    const def = { metrics: [metric({ key: 'a' }), metric({ key: 'b' })] };
    const pv = buildPreview(def, { a: { value: '47201.34', prior_value: '44980.1' }, b: { value: null, prior_value: null } });
    assert.equal(pv.metrics.a.value, 47201.34);
    assert.equal(pv.metrics.a.priorValue, 44980.1);
    assert.equal(pv.metrics.b.value, null);
    assert.equal(pv.metrics.b.priorValue, null);
});

test('buildPreview leaves value null when a metric had no sampled row', () => {
    const pv = buildPreview({ metrics: [metric({ key: 'a' })] }, {});
    assert.deepEqual(pv.metrics.a, { value: null, priorValue: null });
});

// ---- the shipped demo definition must be clean (no false positives) ----

test('the built-in demo definition produces no lint warnings', () => {
    const { getReportDefinition } = require('../src/config/reportDefinition');
    const { definition } = getReportDefinition();
    // Provide plausible in-range sampled values so percent_range doesn't fire.
    const values = {};
    for (const m of definition.metrics) {
        values[m.key] = m.format === 'percent' ? { value: '3.4', prior_value: '3.1' } : { value: '1000', prior_value: '900' };
    }
    const w = lintDefinition(definition, { values });
    assert.deepEqual(w, [], `demo should be clean, got: ${JSON.stringify(w)}`);
});
