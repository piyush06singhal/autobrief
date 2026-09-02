const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry } = require('../src/utils/retry');

test('withRetry returns the result on first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls += 1;
        return 'ok';
    }, { retries: 2, delayMs: 1 });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
});

test('withRetry retries on failure and succeeds on a later attempt', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls += 1;
        if (calls < 2) throw new Error('transient');
        return 'ok';
    }, { retries: 2, delayMs: 1 });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

test('withRetry exhausts all attempts and throws the last error', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls += 1;
            throw new Error(`fail ${calls}`);
        }, { retries: 1, delayMs: 1 }),
        /fail 2/,
    );
    assert.equal(calls, 2);
});

test('withRetry stops immediately when shouldRetry returns false', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls += 1;
            throw new Error('non-retryable');
        }, { retries: 3, delayMs: 1, shouldRetry: () => false }),
        /non-retryable/,
    );
    assert.equal(calls, 1, 'should not have retried at all');
});
