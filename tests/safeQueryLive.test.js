const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runReadOnly } = require('../src/db/safeQuery');
const { pool, closePool } = require('../src/db/pool');

// The real, server-enforced half of the SQL safety model: the READ ONLY
// transaction in runReadOnly(). Unlike the static guard (safeQuery.test.js),
// this needs a live database, so it only runs when RUN_DB_TESTS=1 (see
// `npm run test:db`) with DATABASE_URL pointing at a reachable Postgres.
const DB_TESTS = process.env.RUN_DB_TESTS === '1';
const PROBE = `ro_probe_${process.pid}`; // numeric pid -> safe to interpolate
let canWriteProbe = false;

before(async () => {
    if (!DB_TESTS) return;
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${PROBE} (x int)`);
        canWriteProbe = true;
    } catch {
        // e.g. connected as a read-only role — the CTE write test will skip.
        canWriteProbe = false;
    }
});

after(async () => {
    if (!DB_TESTS) return;
    try { await pool.query(`DROP TABLE IF EXISTS ${PROBE}`); } catch { /* best effort */ }
    await closePool();
});

test('runReadOnly executes a legitimate SELECT', { skip: !DB_TESTS }, async () => {
    const { rows } = await runReadOnly('SELECT 1 AS value');
    assert.equal(Number(rows[0].value), 1);
});

test('runReadOnly blocks a write hidden in a WITH-CTE at the server (SQLSTATE 25006)', async (t) => {
    if (!DB_TESTS || !canWriteProbe) {
        return t.skip('needs RUN_DB_TESTS=1 and a writable role to create the probe table');
    }
    // Begins with WITH, so it passes the static guard; the INSERT inside the CTE
    // can only be caught by the READ ONLY transaction — which is the point.
    await assert.rejects(
        runReadOnly(`WITH d AS (INSERT INTO ${PROBE} VALUES (1) RETURNING x) SELECT count(*) AS value FROM d`),
        (err) => err.code === '25006',
    );
});

test('runReadOnly rejects an UPDATE and a DROP via the static guard', { skip: !DB_TESTS }, async () => {
    // Blocked by assertSelectOnly before touching the DB, so no table needed.
    await assert.rejects(runReadOnly('UPDATE users SET x = 1'), /read-only/i);
    await assert.rejects(runReadOnly('DROP TABLE users'), /read-only/i);
});
