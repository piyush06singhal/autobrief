const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('../src/config/settings');

function tmpSettingsPath() {
    return path.join(os.tmpdir(), `test-settings-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('readSettings returns env-derived defaults when no file exists', () => {
    const { readSettings } = createSettings(tmpSettingsPath(), { reportRecipients: ['default@x.com'] });
    assert.deepEqual(readSettings(), { recipients: ['default@x.com'], testMode: false, testModeEmail: null });
});

test('writeSettings persists and readSettings reflects it', () => {
    const settingsPath = tmpSettingsPath();
    const { readSettings, writeSettings } = createSettings(settingsPath, { reportRecipients: [] });

    writeSettings({ recipients: ['a@x.com', 'b@x.com'] });
    assert.deepEqual(readSettings().recipients, ['a@x.com', 'b@x.com']);
    fs.unlinkSync(settingsPath);
});

test('writeSettings merges partial updates without clobbering other fields', () => {
    const settingsPath = tmpSettingsPath();
    const { readSettings, writeSettings } = createSettings(settingsPath, { reportRecipients: [] });

    writeSettings({ recipients: ['a@x.com'] });
    writeSettings({ testMode: true, testModeEmail: 'safe@x.com' });

    const result = readSettings();
    assert.deepEqual(result, { recipients: ['a@x.com'], testMode: true, testModeEmail: 'safe@x.com' });
    fs.unlinkSync(settingsPath);
});

test('readSettings falls back to defaults if the file has invalid JSON', () => {
    const settingsPath = tmpSettingsPath();
    fs.writeFileSync(settingsPath, 'not valid json{{{');
    const { readSettings } = createSettings(settingsPath, { reportRecipients: ['fallback@x.com'] });
    assert.deepEqual(readSettings(), { recipients: ['fallback@x.com'], testMode: false, testModeEmail: null });
    fs.unlinkSync(settingsPath);
});
