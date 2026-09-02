const fs = require('fs');
const path = require('path');
const { retentionDays } = require('../config/env');
const logger = require('./logger');

const DEFAULT_LOG_PATH = path.join(__dirname, '..', '..', 'output', 'audit-log.json');
// Safety net against unbounded growth independent of the date-based pruning.
// Higher than the run log's cap because admin actions can be far more frequent.
const HARD_CAP = 5000;

// A durable, append-only record of every state-changing admin action: who did
// it (the authenticated Basic Auth user), from where (client IP), when, and
// what. It answers "who triggered this run / changed the recipients / rewrote
// the metrics" after the fact — the accountability half of the auth story that
// a login alone doesn't provide. Mirrors runLog.js: same output/ volume, same
// createX(path, days) factory so tests can point at a temp file.
function createAuditLog(logPath = DEFAULT_LOG_PATH, days = retentionDays) {
    function readAudit() {
        if (!fs.existsSync(logPath)) return [];
        try {
            return JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch {
            return [];
        }
    }

    function record({ action, user, ip, details }) {
        const entry = {
            at: new Date().toISOString(),
            action,
            user: user || 'anonymous (no auth configured)',
            ip: ip || 'unknown',
            ...(details && Object.keys(details).length ? { details } : {}),
        };

        // Also emit to the structured logger so the action shows up in container
        // logs / log aggregation immediately, not only in the on-disk file.
        logger.info('AUDIT', entry);

        const entries = readAudit();
        entries.unshift(entry);

        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const pruned = entries.filter((e) => {
            const t = new Date(e.at).getTime();
            return Number.isNaN(t) || t >= cutoffMs;
        });

        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        try {
            fs.writeFileSync(logPath, JSON.stringify(pruned.slice(0, HARD_CAP), null, 2));
        } catch (err) {
            // A failed audit write must never take down the action it's recording;
            // the logger.info above still captured it.
            logger.error('Failed to write audit log', { error: err.message });
        }
        return entry;
    }

    return { readAudit, record, DEFAULT_LOG_PATH };
}

module.exports = { ...createAuditLog(), createAuditLog, DEFAULT_LOG_PATH };
