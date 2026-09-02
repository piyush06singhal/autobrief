const fs = require('fs');
const path = require('path');
const env = require('./env');

const DEFAULT_SETTINGS_PATH = path.join(__dirname, '..', '..', 'output', 'settings.json');

// Recipients/test-mode are editable at runtime from the admin dashboard,
// which .env can't be (rewriting .env from the app is fragile — comments,
// formatting, concurrent writes). This JSON file lives in the same shared
// output/ volume the scheduler and admin containers already both mount, so
// a change made in the dashboard is picked up by the next scheduled run too.
//
// Factory so tests can point at a temp path instead of the real output/ dir.
function createSettings(settingsPath = DEFAULT_SETTINGS_PATH, envDefaults) {
    function readSettings() {
        const defaults = {
            recipients: envDefaults?.reportRecipients ?? [],
            testMode: false,
            testModeEmail: null,
        };
        if (!fs.existsSync(settingsPath)) return defaults;
        try {
            const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            return {
                recipients: Array.isArray(saved.recipients) ? saved.recipients : defaults.recipients,
                testMode: typeof saved.testMode === 'boolean' ? saved.testMode : defaults.testMode,
                testModeEmail: saved.testModeEmail ?? defaults.testModeEmail,
            };
        } catch {
            return defaults;
        }
    }

    function writeSettings(partial) {
        const current = readSettings();
        const updated = { ...current, ...partial };
        const dir = path.dirname(settingsPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2));
        return updated;
    }

    return { readSettings, writeSettings };
}

module.exports = { ...createSettings(DEFAULT_SETTINGS_PATH, env), createSettings };
