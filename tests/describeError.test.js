const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeError } = require('../src/utils/describeError');

test('describeError uses .message when present', () => {
    assert.equal(describeError(new Error('boom')), 'boom');
});

test('describeError falls back to .errors[] for AggregateError-style errors with a blank message', () => {
    const err = new Error('');
    err.errors = [new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ETIMEDOUT' }];
    assert.equal(describeError(err), 'connect ECONNREFUSED 127.0.0.1:5432; ETIMEDOUT');
});

test('describeError falls back to .code when there is no message or .errors', () => {
    const err = new Error('');
    err.code = 'ECONNRESET';
    assert.equal(describeError(err), 'ECONNRESET');
});

test('describeError falls back to String(err) as a last resort', () => {
    const err = { toString: () => 'weird non-Error object' };
    assert.equal(describeError(err), 'weird non-Error object');
});

test('describeError returns null-safe for a null/undefined error', () => {
    assert.equal(describeError(null), 'null');
    assert.equal(describeError(undefined), 'undefined');
});

// The pg 08P01 bind-count mismatch is how a metric that forgot to reference $1
// surfaces (it can't execute against the single as-of param). The raw message is
// opaque; describeError turns it into the query-contract guidance.
test('describeError explains an 08P01 with requires-0 as a missing $1 (all-time) query', () => {
    const err = new Error('bind message supplies 1 parameters, but prepared statement "" requires 0');
    err.code = '08P01';
    const out = describeError(err);
    assert.match(out, /does not reference \$1/);
    assert.match(out, /all-time total/);
    assert.match(out, /cannot run as a weekly metric/);
});

test('describeError explains an 08P01 requiring more than one param as a too-many-placeholders query', () => {
    const err = new Error('bind message supplies 1 parameters, but prepared statement "" requires 2');
    err.code = '08P01';
    const out = describeError(err);
    assert.match(out, /expects \$2/);
    assert.match(out, /supplies only \$1/);
});

test('describeError leaves an 08P01 it cannot parse as its raw message', () => {
    const err = new Error('some other protocol violation');
    err.code = '08P01';
    assert.equal(describeError(err), 'some other protocol violation');
});
