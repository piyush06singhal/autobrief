const { Pool } = require('pg');
const { databaseUrl, dbPoolMax } = require('../config/env');

// Single shared connection pool for the whole app. Extracted from index.js so
// the metrics runner, the read-only executor (safeQuery.js), and schema
// introspection (introspect.js) all draw from the same pool instead of each
// opening their own.
//
// connectionTimeoutMillis makes a wrong/unreachable DATABASE_URL fail in a few
// seconds with a readable error (surfaced via describeError) instead of hanging
// or emitting a raw pg AggregateError much later in the run.
//
// max bounds how many queries hit the DB at once (metrics run in parallel);
// idleTimeoutMillis returns idle clients so a long-lived scheduler process
// doesn't hold connections open between weekly runs.
const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    max: dbPoolMax,
    idleTimeoutMillis: 30000,
});

// A pool-level error (e.g. the DB dropping an idle connection) would otherwise
// crash the whole process as an unhandled 'error' event. Swallow it here; the
// next query re-establishes a connection and surfaces any real problem itself.
pool.on('error', () => {});

async function closePool() {
    await pool.end();
}

module.exports = { pool, closePool };
