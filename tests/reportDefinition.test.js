const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    validateDefinition, normalizeDefinition, createReportDefinition, DEMO_DEFINITION,
} = require('../src/config/reportDefinition');

function tmpDefPath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reportdef-')), 'report-definition.json');
}

test('the built-in demo definition is structurally valid', () => {
    assert.deepEqual(validateDefinition(DEMO_DEFINITION), []);
});

test('validateDefinition flags a missing key and an invalid format', () => {
    const errors = validateDefinition({
        metrics: [{ label: 'X', sql: 'SELECT 1 AS value', format: 'nope' }],
    });
    assert.ok(errors.some((e) => /missing "key"/.test(e)));
    assert.ok(errors.some((e) => /invalid format/.test(e)));
});

test('validateDefinition requires a non-empty metrics array', () => {
    assert.ok(validateDefinition({ metrics: [] }).length > 0);
    assert.ok(validateDefinition({}).length > 0);
    assert.ok(validateDefinition(null).length > 0);
});

test('validateDefinition flags a chartSeries that matches no trend column', () => {
    const errors = validateDefinition({
        metrics: [{ key: 'a', label: 'A', sql: 'SELECT 1 AS value' }],
        trend: { sql: 'SELECT 1', columns: [{ key: 'x', label: 'X' }], chartSeries: 'y' },
    });
    assert.ok(errors.some((e) => /chartSeries/.test(e)));
});

test('normalizeDefinition fills in sensible defaults', () => {
    const norm = normalizeDefinition({
        metrics: [{ key: 'a', label: 'A', sql: 'SELECT 1 AS value' }],
    });
    assert.equal(norm.metrics[0].format, 'number');
    assert.equal(norm.metrics[0].invertDelta, false);
    assert.equal(norm.metrics[0].deltaMode, 'relative');
    assert.equal(norm.trend, null);
});

test('getReportDefinition returns the demo default when no file exists, and a saved one otherwise', () => {
    const store = createReportDefinition(tmpDefPath());

    const first = store.getReportDefinition();
    assert.equal(first.source, 'demo');
    assert.equal(first.definition.metrics[0].key, 'total_sales');

    store.saveReportDefinition({
        metrics: [{ key: 'rev', label: 'Revenue', format: 'currency', sql: 'SELECT 1 AS value' }],
    });

    const second = store.getReportDefinition();
    assert.equal(second.source, 'saved');
    assert.equal(second.definition.metrics[0].key, 'rev');
    assert.ok(second.definition.generatedAt, 'save stamps generatedAt');
});

test('saveReportDefinition rejects an invalid definition', () => {
    const store = createReportDefinition(tmpDefPath());
    assert.throws(() => store.saveReportDefinition({ metrics: [] }), /invalid report definition/);
});
