const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveRecipients } = require('../src/email/sendgrid');

test('resolveRecipients returns the configured recipients in normal mode', () => {
    const { recipients, redirected } = resolveRecipients(
        { recipients: ['a@co.com', 'b@co.com'], testMode: false, testModeEmail: null },
        'from@co.com'
    );
    assert.deepEqual(recipients, ['a@co.com', 'b@co.com']);
    assert.equal(redirected, false);
});

test('test mode redirects every send to the single test address', () => {
    const { recipients, redirected } = resolveRecipients(
        { recipients: ['a@co.com', 'b@co.com'], testMode: true, testModeEmail: 'me@co.com' },
        'from@co.com'
    );
    assert.deepEqual(recipients, ['me@co.com']);
    assert.equal(redirected, true);
});

test('test mode with no test address falls back to the sender', () => {
    const { recipients, redirected } = resolveRecipients(
        { recipients: ['a@co.com'], testMode: true, testModeEmail: null },
        'from@co.com'
    );
    assert.deepEqual(recipients, ['from@co.com']);
    assert.equal(redirected, true);
});

test('test mode with neither test address nor sender yields no recipients', () => {
    const { recipients, redirected } = resolveRecipients(
        { recipients: ['a@co.com'], testMode: true, testModeEmail: null },
        null
    );
    assert.deepEqual(recipients, []);
    assert.equal(redirected, true);
});

test('resolveRecipients tolerates a missing/invalid recipients list', () => {
    const { recipients } = resolveRecipients({ testMode: false }, 'from@co.com');
    assert.deepEqual(recipients, []);
});
