#!/usr/bin/env node
// Runs the same deep health check the admin /status endpoint exposes, prints it
// as JSON, and exits non-zero when something is actually broken — so any external
// monitor or cron can alert on it without parsing output. With --alert it also
// pushes a Slack/email alert through the same channel as a failed report run,
// which is how an unattended deployment finds out its scheduler has died.
//
//   node scripts/healthcheck.js            # print status, exit 1 on error
//   node scripts/healthcheck.js --alert    # also send a Slack/email alert on error
//
// Exit codes: 0 = ok or degraded (serving), 1 = error (DB down / scheduler dead).
// Run it on a sane cadence (e.g. hourly) — with --alert it fires every time the
// status is 'error', so let your monitor's own dedup, or the cadence, bound it.

const { collectHealth } = require('../src/utils/health');
const { sendAlert } = require('../src/utils/alert');
const { closePool } = require('../src/db/pool');
const logger = require('../src/utils/logger');

async function main() {
    const wantAlert = process.argv.includes('--alert');
    const health = await collectHealth();

    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);

    if (health.status === 'error' && wantAlert) {
        const failing = Object.entries(health.checks)
            .filter(([, c]) => c && c.status === 'error')
            .map(([name, c]) => `${name}: ${c.detail}`)
            .join(' | ');
        await sendAlert({
            subject: 'Report system health check FAILED',
            message: `Automated health check reports status=error. ${failing}`,
        });
    }

    await closePool();
    // Non-zero only on a real problem; 'degraded' (e.g. still on demo metrics) is
    // informational and must not trip a monitor.
    process.exitCode = health.status === 'error' ? 1 : 0;
}

main().catch((err) => {
    logger.error('Health check crashed', { error: err.message });
    process.exitCode = 1;
});
