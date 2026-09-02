const cron = require('node-cron');
const { runWeeklyReport } = require('./weeklyReport');
const { reportCron, reportTimezone } = require('../config/env');
const { assertConfig, usingDemoDefinition } = require('../config/validateConfig');
const { describeError } = require('../utils/describeError');
const { writeHeartbeat, HEARTBEAT_INTERVAL_MS } = require('../utils/health');
const logger = require('../utils/logger');

// Fail fast on a missing DATABASE_URL or an invalid cron expression, with a
// clear message rather than a raw stack trace or a silent no-op scheduler.
assertConfig({ requireCron: true });

if (usingDemoDefinition()) {
    logger.warn('No saved report definition found — running the built-in DEMO metrics. '
        + 'Run `npm run setup` to generate metrics for your own database.');
}

// The scheduler is a long-running process with no HTTP server, so Docker's
// healthcheck can't just curl an endpoint — instead this process touches a
// heartbeat file every HEARTBEAT_INTERVAL_MS, and both the container healthcheck
// (docker-compose.yml) and the admin /status endpoint treat a stale mtime as a
// hung/dead scheduler. The path and writer live in utils/health.js so the reader
// and writer share one definition.
writeHeartbeat();
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);

logger.info(`Scheduler started. Weekly report will run on cron schedule: "${reportCron}" (${reportTimezone})`);

// Pin the schedule to the report's zone so "Monday 8am" fires at 8am in the
// company's locale, not the container's (usually UTC) clock. node-cron accepts
// an IANA zone directly; reportTimezone is validated in env.js.
cron.schedule(reportCron, () => {
    runWeeklyReport().catch((err) => {
        logger.error('Scheduled weekly report run failed', { error: describeError(err) });
    });
}, { timezone: reportTimezone });
