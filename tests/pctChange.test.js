const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pctChange, computeDelta } = require('../src/utils/pctChange');

test('pctChange computes relative change to one decimal place', () => {
    assert.equal(pctChange(150, 100), 50);
    assert.equal(pctChange(50, 100), -50);
    assert.equal(pctChange(110, 100), 10);
    assert.equal(pctChange(133, 100), 33);
});

test('pctChange treats a zero prior as +100% (or 0% when current is also 0)', () => {
    assert.equal(pctChange(200, 0), 100);
    assert.equal(pctChange(0, 0), 0);
});

test('computeDelta absolute mode returns the raw difference (percentage points)', () => {
    assert.equal(computeDelta(2.5, 2.0, 'absolute'), 0.5);
    assert.equal(computeDelta(2.0, 2.5, 'absolute'), -0.5);
});

test('computeDelta defaults to relative mode', () => {
    assert.equal(computeDelta(150, 100), 50);
    assert.equal(computeDelta(150, 100, 'relative'), 50);
});
