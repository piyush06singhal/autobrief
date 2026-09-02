const fs = require('fs');
const path = require('path');
const { retentionDays } = require('../config/env');
const logger = require('../utils/logger');

const DEFAULT_OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');

// Factory so tests can point at a temp dir instead of the real output/ dir.
function createRetention(outputDir = DEFAULT_OUTPUT_DIR, days = retentionDays) {
    // Deletes archived PDFs older than `days`. Run-log entries for deleted
    // files are left in place (metrics history stays useful even once the
    // PDF is gone); the admin dashboard's "View PDF" link just 404s for them.
    function cleanupOldReports() {
        if (!fs.existsSync(outputDir)) return 0;

        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.pdf'));
        let removed = 0;

        for (const file of files) {
            const filePath = path.join(outputDir, file);
            if (fs.statSync(filePath).mtimeMs < cutoffMs) {
                fs.unlinkSync(filePath);
                removed += 1;
            }
        }

        if (removed > 0) {
            logger.info(`Retention cleanup removed ${removed} report(s) older than ${days} days`);
        }
        return removed;
    }

    return { cleanupOldReports };
}

module.exports = { ...createRetention(), createRetention };
