const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuditLog } = require('../src/utils/auditLog');

function tmpLog() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'audit-log.json');
}

test('audit: records an entry with action, user, ip and timestamp', () => {
    const { record, readAudit } = createAuditLog(tmpLog(), 90);
    const entry = record({ action: 'RUN_TRIGGERED', user: 'admin', ip: '1.2.3.4' });
    assert.equal(entry.action, 'RUN_TRIGGERED');
    assert.equal(entry.user, 'admin');
    assert.equal(entry.ip, '1.2.3.4');
    assert.ok(entry.at, 'has a timestamp');

    const all = readAudit();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], entry);
});

test('audit: newest entry is first and details are preserved', () => {
    const { record, readAudit } = createAuditLog(tmpLog(), 90);
    record({ action: 'SETTINGS_UPDATED', user: 'a', ip: 'x', details: { recipientCount: 3, testMode: false } });
    record({ action: 'DEFINITION_SAVED', user: 'a', ip: 'x', details: { metricCount: 5 } });
    const all = readAudit();
    assert.equal(all[0].action, 'DEFINITION_SAVED'); // most recent first
    assert.deepEqual(all[0].details, { metricCount: 5 });
    assert.equal(all[1].action, 'SETTINGS_UPDATED');
});

test('audit: a missing user is labelled rather than left blank', () => {
    const { record } = createAuditLog(tmpLog(), 90);
    const entry = record({ action: 'RUN_TRIGGERED', ip: 'x' });
    assert.match(entry.user, /no auth/); // open-mode action is attributable as such
});

test('audit: entries older than the retention window are pruned on write', () => {
    const logPath = tmpLog();
    const old = {
        at: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
        action: 'RUN_TRIGGERED', user: 'a', ip: 'x',
    };
    fs.writeFileSync(logPath, JSON.stringify([old], null, 2));
    const { record, readAudit } = createAuditLog(logPath, 90); // keep 90 days
    record({ action: 'SETTINGS_UPDATED', user: 'a', ip: 'x' });
    const all = readAudit();
    assert.equal(all.length, 1); // the 100-day-old entry was dropped
    assert.equal(all[0].action, 'SETTINGS_UPDATED');
});

test('audit: a corrupt log file reads as empty rather than throwing', () => {
    const logPath = tmpLog();
    fs.writeFileSync(logPath, '{ not valid json');
    const { readAudit } = createAuditLog(logPath, 90);
    assert.deepEqual(readAudit(), []);
});
