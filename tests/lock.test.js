const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLock } = require('../src/utils/lock');

function tmpLockPath() {
    return path.join(os.tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

test('acquireLock succeeds when no lock exists, fails while held, succeeds again after release', () => {
    const lockPath = tmpLockPath();
    const { acquireLock, releaseLock } = createLock(lockPath, 5000);
    try {
        assert.equal(acquireLock(), true);
        assert.equal(acquireLock(), false, 'a second acquire while held should fail');
        releaseLock();
        assert.equal(acquireLock(), true, 'should succeed again after release');
    } finally {
        releaseLock();
    }
});

test('acquireLock auto-removes a stale lock left by a crashed process', () => {
    const lockPath = tmpLockPath();
    const { acquireLock, releaseLock } = createLock(lockPath, 100);
    try {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
        const oldTime = new Date(Date.now() - 1000);
        fs.utimesSync(lockPath, oldTime, oldTime);

        assert.equal(acquireLock(), true, 'stale lock should be removed and re-acquired');
    } finally {
        releaseLock();
    }
});

test('releaseLock is a no-op if the lock file does not exist', () => {
    const lockPath = tmpLockPath();
    const { releaseLock } = createLock(lockPath, 5000);
    assert.doesNotThrow(() => releaseLock());
});
