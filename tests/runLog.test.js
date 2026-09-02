const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunLog } = require('../src/jobs/runLog');

function tmpLogPath() {
    return path.join(os.tmpdir(), `test-run-log-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('readLog returns an empty array when no file exists yet', () => {
    const { readLog } = createRunLog(tmpLogPath(), 90);
    assert.deepEqual(readLog(), []);
});

test('appendRun prunes entries older than the retention window and keeps recent ones', () => {
    const logPath = tmpLogPath();
    const { readLog, appendRun } = createRunLog(logPath, 90);

    const now = new Date();
    const old = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    fs.writeFileSync(logPath, JSON.stringify([
        { runAt: recent.toISOString(), tag: 'recent' },
        { runAt: old.toISOString(), tag: 'old' },
    ]));

    appendRun({ runAt: now.toISOString(), tag: 'new' });

    const tags = readLog().map((e) => e.tag);
    assert.deepEqual(tags, ['new', 'recent']);
    fs.unlinkSync(logPath);
});

test('appendRun creates the parent directory if it does not exist', () => {
    const dir = path.join(os.tmpdir(), `test-runlog-dir-${Date.now()}`);
    const logPath = path.join(dir, 'run-log.json');
    const { readLog, appendRun } = createRunLog(logPath, 90);

    appendRun({ runAt: new Date().toISOString(), tag: 'first' });

    assert.equal(readLog().length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});
