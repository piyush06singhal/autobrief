const fs = require('fs');
const path = require('path');
const { retentionDays } = require('../config/env');

const DEFAULT_LOG_PATH = path.join(__dirname, '..', '..', 'output', 'run-log.json');
// Safety net against unbounded growth if RETENTION_DAYS is set very high —
// independent of the date-based pruning below.
const HARD_CAP = 1000;

// Factory so tests can point at a temp file instead of the real output/ dir.
function createRunLog(logPath = DEFAULT_LOG_PATH, days = retentionDays) {
    function readLog() {
        if (!fs.existsSync(logPath)) return [];
        try {
            return JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch {
            return [];
        }
    }

    // Prunes by the same RETENTION_DAYS window as the archived PDFs, so the
    // log doesn't drift out of sync with which PDFs actually still exist.
    function appendRun(entry) {
        const entries = readLog();
        entries.unshift(entry);

        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const pruned = entries.filter((e) => {
            const t = new Date(e.runAt).getTime();
            return Number.isNaN(t) || t >= cutoffMs;
        });

        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(logPath, JSON.stringify(pruned.slice(0, HARD_CAP), null, 2));
    }

    return { readLog, appendRun };
}

module.exports = { ...createRunLog(), createRunLog };
