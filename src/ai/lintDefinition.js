// Advisory semantic review of a report definition — the layer that strengthens
// the ONE-TIME human approval gate (`npm run setup` and the /configure page).
//
// The shape-validator already guarantees a query RUNS and returns the right
// columns. It cannot tell whether the query measures the semantically correct
// thing — that's the "autonomy asterisk". Nothing here changes that fundamental
// limit, but it makes the human's approval a well-informed one instead of a
// blind "looks like SQL, sure":
//
//   1. buildPreview() surfaces the ACTUAL value each query returns right now, so
//      an obviously-wrong number ($0, $3.4B, a 1,413% rate) is caught by eye far
//      more easily than a subtle bug in unread SQL. This is the primary gate:
//      a wrong number is visible even when the SQL looks plausible.
//   2. lintDefinition() flags the objective red flags a machine can see on a
//      definition that already validated — a percent whose value falls outside
//      0–100 (a raw count mislabeled as a rate), this-week == prior-week, and
//      format/label/delta-direction mismatches.
//
// A note on time-bounding: a metric whose SQL never references $1 is caught
// earlier and harder than any lint — it literally cannot execute, because every
// query is run with the as-of timestamp as $1, so pg rejects it (08P01) and
// describeError() turns that into "must bound its window with $1". By the time a
// definition reaches this linter its metrics have all executed, so the
// not_time_bounded check below is belt-and-suspenders: it only fires if a
// definition is linted WITHOUT being run first, and is kept as documentation of
// the contract, not as the real enforcement.
//
// Everything here is ADVISORY. It never blocks saving: whether a metric measures
// the right thing is the operator's call, and a warning may be a false positive
// (a deliberately all-time "total users to date" snapshot, say). We surface,
// we don't veto.

// Clearly-monetary terms: if the label reads like money but the format isn't
// currency, the value won't render with a "$". Kept conservative on purpose —
// an advisory that cries wolf gets ignored.
const MONEY_WORDS = /\b(revenue|sales|mrr|arr|gmv|income|profit|earnings|turnover)\b/i;
// Clearly count-like terms: if the label is a count but the format is currency,
// it'll wrongly render a "$".
const COUNT_WORDS = /\b(count|number of|signups?|sign-?ups?|new users?|active users?|sessions?|visits?|clicks?|page ?views?)\b/i;
// Metrics where DOWN is the good direction — they should have invertDelta=true
// so a decrease shows green.
const LOWER_IS_BETTER = /\b(churn|refunds?|cancel(?:led|ed|lation|lations)?|bounces?|complaints?|overdue|failed|failures?|abandon(?:ed|ment)?)\b/i;

// Does the SQL reference the $1 as-of parameter at all? In practice a metric
// that doesn't can't even run (see the header note), so this is a documentation
// check; it only fires when a definition is linted without being executed first.
function referencesAsOf(sql) {
    return /\$1\b/.test(String(sql || ''));
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Per-metric lints. `sample` is the raw first row from a dry-run (may be
// undefined when we haven't run the query), with `value` / `prior_value`.
function lintMetric(m, sample) {
    const out = [];
    const label = m.label || m.key || '(unnamed metric)';
    const target = `metric "${m.key || m.label || '?'}"`;
    const push = (level, code, message) => out.push({ level, target, code, message });

    if (!referencesAsOf(m.sql)) {
        push('warn', 'not_time_bounded',
            `${label}: the SQL never references $1, so it likely reports an all-time figure rather than this week's. `
            + 'Confirm that is intended for a weekly report.');
    }
    if (LOWER_IS_BETTER.test(label) && !m.invertDelta) {
        push('info', 'invert_delta',
            `${label}: the name suggests lower is better, but it's set so higher shows as good. `
            + 'If a decrease is good news here, turn on "lower is better".');
    }
    if (MONEY_WORDS.test(label) && m.format !== 'currency') {
        push('info', 'format_currency',
            `${label}: the name looks monetary but the format is "${m.format || 'number'}", so it won't show a "$". `
            + 'Set the format to currency if this is money.');
    }
    if (COUNT_WORDS.test(label) && m.format === 'currency') {
        push('info', 'format_count',
            `${label}: the name looks like a count but the format is currency, so it'll show a "$". `
            + 'Set the format to number if this is a count.');
    }

    const value = sample ? num(sample.value) : null;
    const prior = sample ? num(sample.prior_value) : null;
    if (m.format === 'percent' && value !== null && (value < 0 || value > 100)) {
        push('warn', 'percent_range',
            `${label}: it's formatted as a percent but currently returns ${value}, outside the 0–100 range. `
            + 'It may be returning a raw count instead of a ratio.');
    }
    if (value !== null && prior !== null && value === prior && value !== 0) {
        push('info', 'value_equals_prior',
            `${label}: this week and the prior week are exactly equal (${value}). `
            + 'Double-check the two windows are actually different.');
    }
    return out;
}

function lintTrend(trend) {
    if (!trend || !trend.sql) return [];
    if (!referencesAsOf(trend.sql)) {
        return [{
            level: 'warn', target: 'trend', code: 'not_time_bounded',
            message: 'Trend chart: the SQL never references $1, so it may not be bounded to the last 7 days. '
                + 'Confirm the date window.',
        }];
    }
    return [];
}

// Runs every lint over a definition. `values` maps metric key -> the raw dry-run
// row ({ value, prior_value }); omit it (or leave keys out) and the value-based
// checks simply don't fire. Returns a flat array of { level, target, code,
// message }, most-actionable ('warn') naturally grouped by how they're rendered.
function lintDefinition(definition, { values = {} } = {}) {
    const warnings = [];
    for (const m of definition.metrics || []) {
        warnings.push(...lintMetric(m, values[m.key]));
    }
    warnings.push(...lintTrend(definition.trend));
    return warnings;
}

// Turns the raw dry-run rows into a display-ready preview: metric key -> the
// numeric value/priorValue the query returned. Shared by the setup CLI and the
// /configure page so both show identical numbers next to each metric.
function buildPreview(definition, values = {}) {
    const metrics = {};
    for (const m of definition.metrics || []) {
        const s = values[m.key];
        metrics[m.key] = {
            value: s ? num(s.value) : null,
            priorValue: s ? num(s.prior_value) : null,
        };
    }
    return { metrics };
}

module.exports = {
    lintDefinition,
    buildPreview,
    // exported for unit tests:
    referencesAsOf,
    MONEY_WORDS,
    COUNT_WORDS,
    LOWER_IS_BETTER,
};
