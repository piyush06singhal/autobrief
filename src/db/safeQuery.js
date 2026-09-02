const { pool } = require('./pool');
const { dbStatementTimeoutMs, reportTimezone } = require('../config/env');

// Per-query timeout (ms). Configurable via DB_STATEMENT_TIMEOUT_MS so a heavy
// aggregation over a large production table isn't cut off, while a runaway
// query still can't hang the job. Callers may override per call.
const DEFAULT_TIMEOUT_MS = dbStatementTimeoutMs;

// The session time zone every query runs under, so date_trunc('day', ...) and
// to_char(...) in the daily trend bucket/label by the company's local day, not
// the container's UTC clock. reportTimezone is validated as a real IANA zone in
// env.js; the charset is constrained again here because SET LOCAL cannot be
// parameterized and must be interpolated. IANA names use letters, digits, and
// _ + - / (e.g. "Etc/GMT+5", "America/Argentina/Buenos_Aires") — never a quote.
const SESSION_TZ = /^[A-Za-z0-9_+\-/]+$/.test(reportTimezone) ? reportTimezone : 'UTC';

// Statements a metric query is never allowed to begin with. The READ ONLY
// transaction below is the real, server-enforced guarantee — this static check
// is only fast, friendly defense-in-depth so an obviously-wrong query is
// rejected before it ever reaches the database.
function assertSelectOnly(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw new Error('Query is empty.');
    }

    // Strip comments so they can't hide a second statement or a leading keyword.
    const stripped = sql
        .replace(/--[^\n]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .trim()
        .replace(/;\s*$/, ''); // a single trailing semicolon is fine

    if (!stripped) {
        throw new Error('Query is empty after removing comments.');
    }
    // Any remaining semicolon means a second statement was stacked on.
    if (stripped.includes(';')) {
        throw new Error('Only a single SQL statement is allowed (found ";").');
    }
    if (!/^(with|select)\b/i.test(stripped)) {
        throw new Error('Only read-only SELECT / WITH queries are allowed.');
    }
}

// Runs a single read-only query and returns the pg result.
//
// Safety model for executing queries that may have been written by the LLM
// against a real (possibly production) database:
//   1. assertSelectOnly()   — reject non-SELECT / multi-statement up front.
//   2. parameterized ($1)   — forces pg's extended protocol, which permits
//      exactly one statement, so nothing can be stacked after it.
//   3. READ ONLY transaction — Postgres refuses any write/DDL inside it
//      (SQLSTATE 25006) no matter what the SQL text says.
//   4. statement_timeout    — a runaway/expensive query can't hang the job.
async function runReadOnly(sql, params = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    assertSelectOnly(sql);

    const client = await pool.connect();
    try {
        await client.query('BEGIN TRANSACTION READ ONLY');
        // timeoutMs is coerced to a number so it can never carry injected SQL.
        await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
        // Pin the session zone so day bucketing/labels match the report's locale.
        await client.query(`SET LOCAL timezone = '${SESSION_TZ}'`);
        const result = await client.query(sql, params);
        await client.query('ROLLBACK');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Connection may already be broken; nothing useful to do.
        }
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { runReadOnly, assertSelectOnly, DEFAULT_TIMEOUT_MS, SESSION_TZ };
