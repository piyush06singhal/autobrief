// Runs every query in the ACTIVE report definition standalone and reports
// exactly which one is broken and why — instead of making you dig through a
// stack trace from a full report run.
//
// The active definition is output/report-definition.json if present (written by
// `npm run setup`), otherwise the built-in demo definition. So this checks the
// real queries the weekly report will run against whatever DATABASE_URL points
// at.
//
// Usage: npm run db:validate

const { databaseUrl } = require('../src/config/env');
const { getReportDefinition } = require('../src/config/reportDefinition');
const { runReadOnly } = require('../src/db/safeQuery');
const { closePool } = require('../src/db/pool');
const { describeError } = require('../src/utils/describeError');

const TEST_AS_OF = new Date();

async function main() {
    if (!databaseUrl) {
        console.error('✗ DATABASE_URL is not set in .env');
        process.exit(1);
    }

    const { definition, source } = getReportDefinition();
    console.log(`Connecting to: ${databaseUrl.replace(/:[^:@]*@/, ':****@')}`);
    console.log(`Validating the ${source === 'saved' ? 'saved' : 'built-in demo'} report definition `
        + `(${definition.metrics.length} metric(s)${definition.trend ? ' + a trend' : ''})\n`);

    let allPassed = true;

    for (const metric of definition.metrics) {
        try {
            const { rows } = await runReadOnly(metric.sql, [TEST_AS_OF]);
            const row = rows[0];
            if (!row) {
                console.error(`✗ metric "${metric.key}" ran but returned no rows`);
                allPassed = false;
            } else if (!('value' in row)) {
                console.error(`✗ metric "${metric.key}" is missing the required "value" column`);
                console.error(`  Got columns: ${Object.keys(row).join(', ')}`);
                allPassed = false;
            } else {
                const prior = 'prior_value' in row ? `, prior_value=${row.prior_value}` : '';
                console.log(`✓ metric "${metric.key}" OK — value=${row.value}${prior}`);
            }
        } catch (err) {
            console.error(`✗ metric "${metric.key}" failed: ${describeError(err)}`);
            allPassed = false;
        }
    }

    if (definition.trend) {
        try {
            const { rows } = await runReadOnly(definition.trend.sql, [TEST_AS_OF]);
            const missing = [];
            if (rows.length === 0) {
                console.error('✗ trend query returned no rows');
                allPassed = false;
            } else {
                if (!('label' in rows[0])) missing.push('label');
                for (const col of definition.trend.columns) {
                    if (!(col.key in rows[0])) missing.push(col.key);
                }
                if (missing.length > 0) {
                    console.error(`✗ trend query is missing column(s): ${missing.join(', ')}`);
                    console.error(`  Got columns: ${Object.keys(rows[0]).join(', ')}`);
                    allPassed = false;
                } else {
                    console.log(`✓ trend OK — ${rows.length} point(s) returned`);
                }
            }
        } catch (err) {
            console.error(`✗ trend query failed: ${describeError(err)}`);
            allPassed = false;
        }
    }

    await closePool();

    console.log('');
    if (allPassed) {
        console.log('All queries look correct against this database. Safe to run: npm run report:run');
        process.exit(0);
    } else {
        console.log('Fix the definition above (npm run setup to regenerate, or edit it in the admin dashboard), then re-run this check.');
        process.exit(1);
    }
}

main();
