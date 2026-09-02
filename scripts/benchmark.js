// Benchmarks every query in the ACTIVE report definition against whatever
// DATABASE_URL points at, and flags the two things that actually bite at scale:
// a query that runs slowly (approaching the statement timeout) and a query that
// sequentially scans a large table (a missing or unusable index).
//
// This turns "it should handle large tables" into something you can PROVE on
// your own data before trusting the weekly run. It executes the real SQL through
// the same read-only, timeout-bounded path the report uses, plus an EXPLAIN
// ANALYZE to see how Postgres actually executes each query.
//
// Usage: npm run benchmark            (BENCH_RUNS=5 npm run benchmark for more samples)

const { databaseUrl, dbStatementTimeoutMs } = require('../src/config/env');
const { getReportDefinition } = require('../src/config/reportDefinition');
const { runReadOnly, SESSION_TZ } = require('../src/db/safeQuery');
const { pool, closePool } = require('../src/db/pool');
const { describeError } = require('../src/utils/describeError');

const RUNS = Number(process.env.BENCH_RUNS) || 3;
const TEST_AS_OF = new Date();

// A query that takes more than half the timeout has little headroom; one that
// scans more than this many rows sequentially almost certainly wants an index.
const SLOW_MS = dbStatementTimeoutMs * 0.5;
const BIG_SEQ_SCAN_ROWS = 50000;

function fmtMs(ms) {
    if (ms == null) return '—';
    return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// Walk the EXPLAIN plan tree, collecting every sequential scan and its actual
// row count so we can flag large ones.
function walkPlan(node, acc) {
    if (!node) return acc;
    if (node['Node Type'] === 'Seq Scan') {
        acc.seqScans.push({ rel: node['Relation Name'], rows: node['Actual Rows'] });
    } else if (/Index/.test(node['Node Type'] || '')) {
        acc.indexScans += 1;
    }
    for (const child of node['Plans'] || []) walkPlan(child, acc);
    return acc;
}

// EXPLAIN ANALYZE executes the query, so run it inside the same READ ONLY,
// timeout-bounded transaction the app uses — even a hand-edited write is blocked.
async function explainAnalyze(sql) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${Number(dbStatementTimeoutMs)}`);
        await client.query(`SET LOCAL timezone = '${SESSION_TZ}'`);
        const r = await client.query({
            text: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql,
            values: [TEST_AS_OF],
        });
        await client.query('ROLLBACK');
        const plan = r.rows[0]['QUERY PLAN'][0];
        const acc = walkPlan(plan.Plan, { seqScans: [], indexScans: 0 });
        return { execMs: plan['Execution Time'], ...acc };
    } finally {
        client.release();
    }
}

// Median wall-clock over RUNS executions through the real read-only executor.
async function timeQuery(sql) {
    const times = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = process.hrtime.bigint();
        await runReadOnly(sql, [TEST_AS_OF]);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
}

async function benchOne(name, sql) {
    try {
        const medianMs = await timeQuery(sql);
        const plan = await explainAnalyze(sql);
        const warnings = [];
        if (medianMs > SLOW_MS) {
            warnings.push(`slow: ${fmtMs(medianMs)} is over half the ${fmtMs(dbStatementTimeoutMs)} timeout — little headroom as data grows`);
        }
        for (const s of plan.seqScans) {
            if (s.rows >= BIG_SEQ_SCAN_ROWS) {
                warnings.push(`sequential scan of ${s.rows.toLocaleString()} rows on "${s.rel}" — add an index on the column this query filters/joins on`);
            }
        }
        return { name, ok: true, medianMs, plan, warnings };
    } catch (err) {
        const reason = describeError(err);
        const timedOut = /statement timeout|57014/.test(reason);
        return { name, ok: false, reason, timedOut };
    }
}

async function main() {
    if (!databaseUrl) {
        console.error('✗ DATABASE_URL is not set in .env');
        process.exit(1);
    }

    const { definition, source } = getReportDefinition();
    console.log(`Connecting to: ${databaseUrl.replace(/:[^:@]*@/, ':****@')}`);
    console.log(`Benchmarking the ${source === 'saved' ? 'saved' : 'built-in demo'} definition `
        + `(${definition.metrics.length} metric(s)${definition.trend ? ' + a trend' : ''}), median of ${RUNS} run(s).`);
    console.log(`Timeout is ${fmtMs(dbStatementTimeoutMs)} (DB_STATEMENT_TIMEOUT_MS); warning above ${fmtMs(SLOW_MS)}.\n`);

    const jobs = definition.metrics.map((m) => [`metric "${m.key}"`, m.sql]);
    if (definition.trend) jobs.push(['trend', definition.trend.sql]);

    const results = [];
    for (const [name, sql] of jobs) results.push(await benchOne(name, sql));

    const pad = Math.max(...results.map((r) => r.name.length));
    let anyWarn = false;
    let anyFail = false;

    for (const r of results) {
        if (!r.ok) {
            anyFail = true;
            console.log(`✗ ${r.name.padEnd(pad)}  FAILED${r.timedOut ? ' (timed out)' : ''}: ${r.reason}`);
            continue;
        }
        const scan = r.plan.seqScans.length === 0 ? 'index' : `${r.plan.seqScans.length} seq scan(s)`;
        const flag = r.warnings.length ? '⚠' : '✓';
        console.log(`${flag} ${r.name.padEnd(pad)}  ${fmtMs(r.medianMs).padStart(8)}   [${scan}]`);
        for (const w of r.warnings) {
            anyWarn = true;
            console.log(`   ↳ ${w}`);
        }
    }

    await closePool();

    console.log('');
    if (anyFail) {
        console.log('Some queries failed or timed out. If it timed out on a large table, add an index on the');
        console.log('filtered/joined column, or raise DB_STATEMENT_TIMEOUT_MS if the aggregation legitimately needs it.');
        process.exit(1);
    }
    if (anyWarn) {
        console.log('All queries ran, but the ⚠ ones will degrade as your tables grow. The fix is almost always an');
        console.log('index on the timestamp column each query filters on (e.g. CREATE INDEX ON orders (created_at)).');
        process.exit(0);
    }
    console.log('All queries are fast and index-backed on this database. Good to scale.');
    process.exit(0);
}

if (require.main === module) main();

module.exports = { benchOne, explainAnalyze, walkPlan, timeQuery };
