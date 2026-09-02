const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULT_LOCK_PATH = path.join(__dirname, '..', '..', 'output', '.report.lock');
// Longer than any real report run should take. If a lock file is older than
// this, assume the process that created it crashed without cleaning up.
const DEFAULT_STALE_MS = 15 * 60 * 1000;

// Factory so tests can point at a temp path instead of the real output/ dir.
// The scheduler and admin dashboard run as separate Docker containers, so an
// in-process mutex wouldn't stop them racing each other — this uses the
// output/ volume they already share as the coordination point instead.
function createLock(lockPath = DEFAULT_LOCK_PATH, staleMs = DEFAULT_STALE_MS) {
    function acquireLock() {
        const dir = path.dirname(lockPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        try {
            // 'wx' = exclusive create, fails atomically if the file already exists.
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
            fs.closeSync(fd);
            return true;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;

            try {
                const age = Date.now() - fs.statSync(lockPath).mtimeMs;
                if (age > staleMs) {
                    logger.warn('Removing stale report lock left behind by a crashed run', { ageMs: age });
                    fs.unlinkSync(lockPath);
                    return acquireLock();
                }
            } catch {
                // Lock vanished between the EEXIST and the stat/unlink (another
                // process released it) — just retry once via recursion below.
                return acquireLock();
            }
            return false;
        }
    }

    function releaseLock() {
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Already gone — nothing to do.
        }
    }

    return { acquireLock, releaseLock };
}

module.exports = { ...createLock(), createLock };
