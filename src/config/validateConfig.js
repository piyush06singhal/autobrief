const cron = require('node-cron');
const { databaseUrl, reportCron, groqApiKey } = require('./env');
const { definitionExists } = require('./reportDefinition');

// Fail-fast configuration checks, so a misconfigured deployment produces a
// clear, actionable message at startup instead of a raw stack trace deep in a
// run. These are synchronous (no DB I/O) — actual DB reachability is surfaced
// separately by the pool's connectionTimeoutMillis + describeError.

// Returns an array of human-readable problem strings ([] when all good).
function validateConfig({ requireCron = false, requireLlm = false } = {}) {
    const problems = [];

    if (!databaseUrl) {
        problems.push(
            'DATABASE_URL is not set. Copy .env.example to .env and point it at your '
            + 'Postgres database (ideally a read-only role — see the README safety notes).',
        );
    }

    if (requireCron && !cron.validate(reportCron)) {
        problems.push(`REPORT_CRON is not a valid cron expression: "${reportCron}".`);
    }

    if (requireLlm && !groqApiKey) {
        problems.push(
            'GROQ_API_KEY is not set. Set it in .env (or configure LLM_BASE_URL and a '
            + 'compatible key) so the AI can generate metrics.',
        );
    }

    return problems;
}

// A hint (not an error) that setup hasn't been run — the built-in demo
// definition is active. Callers can surface this to nudge a new deployment
// toward `npm run setup` without blocking.
function usingDemoDefinition() {
    return !definitionExists();
}

// Prints problems and exits(1) if any. Used at the top of the scheduler, the
// admin server, and the report scripts.
function assertConfig(opts) {
    const problems = validateConfig(opts);
    if (problems.length > 0) {
        console.error('✗ Configuration problem(s) — cannot start:\n');
        for (const p of problems) console.error(`  - ${p}`);
        console.error('');
        process.exit(1);
    }
}

module.exports = { validateConfig, assertConfig, usingDemoDefinition };
