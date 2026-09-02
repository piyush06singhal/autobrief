const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRetention } = require('../src/jobs/retention');

function tmpDir() {
    const dir = path.join(os.tmpdir(), `test-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

test('cleanupOldReports deletes PDFs older than the retention window, keeps recent ones', () => {
    const dir = tmpDir();
    const oldFile = path.join(dir, 'old.pdf');
    const recentFile = path.join(dir, 'recent.pdf');
    fs.writeFileSync(oldFile, 'x');
    fs.writeFileSync(recentFile, 'x');

    const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldTime, oldTime);

    const { cleanupOldReports } = createRetention(dir, 90);
    const removed = cleanupOldReports();

    assert.equal(removed, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(recentFile), true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupOldReports ignores non-PDF files', () => {
    const dir = tmpDir();
    const oldTextFile = path.join(dir, 'old.txt');
    fs.writeFileSync(oldTextFile, 'x');
    const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldTextFile, oldTime, oldTime);

    const { cleanupOldReports } = createRetention(dir, 90);
    const removed = cleanupOldReports();

    assert.equal(removed, 0);
    assert.equal(fs.existsSync(oldTextFile), true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupOldReports does nothing if the directory does not exist', () => {
    const { cleanupOldReports } = createRetention(path.join(os.tmpdir(), 'does-not-exist-xyz'), 90);
    assert.doesNotThrow(() => cleanupOldReports());
});
