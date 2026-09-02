// pg raises 08P01 ("bind message supplies N parameters, but prepared statement
// requires M") when a query's $-placeholders don't match the single as-of
// timestamp ($1) that every metric/trend query is run with. The overwhelmingly
// common case is M=0: the query forgot to reference $1 at all, so it would have
// reported an ALL-TIME total instead of the reporting week — and it can't even
// execute. The raw pg text is opaque to an operator; turn it into guidance that
// says exactly what the query contract requires. This is the reachable, real
// enforcement of "a weekly metric must be time-bounded": such a query is dropped
// (setup), blocked (admin save), or logged (runtime), all with this message.
function explainBindMismatch(err) {
    // Real pg text: `bind message supplies 1 parameters, but prepared
    // statement "" requires 0` — note the trailing count has no "parameter(s)".
    const m = /bind message supplies \d+ parameters?.*requires (\d+)/is.exec(err.message || '');
    if (!m) return null;
    const requires = Number(m[1]);
    if (requires === 0) {
        return 'query does not reference $1 (the as-of timestamp). A weekly metric must bound its window '
            + "with $1 — e.g. \"WHERE ts_col >= $1::timestamptz - INTERVAL '7 days' AND ts_col < $1::timestamptz\". "
            + 'Without it the query would report an all-time total, so it cannot run as a weekly metric.';
    }
    return `query expects $${requires}, but the report supplies only $1 (the as-of timestamp). Reference $1 only.`;
}

// Node's AggregateError (thrown by pg when a connection is refused on both
// IPv4/IPv6) has an empty top-level .message — the real detail is nested in
// .errors[]. This pulls out something actually readable for logs/alerts.
function describeError(err) {
    if (!err) return String(err);
    if (err.code === '08P01') {
        const explained = explainBindMismatch(err);
        if (explained) return explained;
    }
    if (err.message) return err.message;
    if (Array.isArray(err.errors) && err.errors.length > 0) {
        return err.errors.map((e) => e.message || e.code || String(e)).join('; ');
    }
    if (err.code) return err.code;
    return String(err);
}

module.exports = { describeError };
