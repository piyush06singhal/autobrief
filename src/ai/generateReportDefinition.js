const { generatorModel } = require('../config/env');
const { callLLM } = require('./llmClient');
const { introspectSchema, formatSchemaForPrompt } = require('../db/introspect');
const { runReadOnly } = require('../db/safeQuery');
const { validateDefinition } = require('../config/reportDefinition');
const { lintDefinition, buildPreview } = require('./lintDefinition');
const { describeError } = require('../utils/describeError');

// Generates a report definition for whatever database DATABASE_URL points at:
// introspect the schema -> ask the LLM for metrics obeying the query contract
// -> run each generated query against the live DB and feed failures back to the
// model to fix, for a few rounds -> keep what validates.
//
// IMPORTANT (stated plainly to users too): validation guarantees each query
// EXECUTES and returns the right SHAPE. It does NOT guarantee the query measures
// the semantically correct thing. The one-time human approval in `npm run setup`
// (and the /configure admin page) is the correctness gate.

const MAX_METRICS = 8; // cap what we'll validate even if the model over-produces

// ---- pure helpers (unit-tested without network or DB) --------------------

// Pulls a JSON object out of an LLM response that may be fenced in ```json or
// wrapped in prose.
function extractJson(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('LLM returned empty content.');
    }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        throw new Error('No JSON object found in the LLM output.');
    }
    return JSON.parse(candidate.slice(start, end + 1));
}

// The scalar-metric shape check: exactly-one-row with a `value` column.
function checkMetricShape(rows) {
    if (!rows || rows.length === 0) {
        return { ok: false, reason: 'query returned no rows (must return exactly one row)' };
    }
    if (!('value' in rows[0])) {
        return { ok: false, reason: `row is missing a "value" column (got: ${Object.keys(rows[0]).join(', ') || 'no columns'})` };
    }
    return { ok: true };
}

// The trend shape check: >=1 row with `label` plus every declared column key.
function checkTrendShape(rows, columns) {
    if (!rows || rows.length === 0) {
        return { ok: false, reason: 'trend query returned no rows' };
    }
    const missing = [];
    if (!('label' in rows[0])) missing.push('label');
    for (const c of columns || []) {
        if (!(c.key in rows[0])) missing.push(c.key);
    }
    if (missing.length > 0) {
        return { ok: false, reason: `trend is missing column(s): ${missing.join(', ')} (got: ${Object.keys(rows[0]).join(', ')})` };
    }
    return { ok: true };
}

function isUsableMetric(m) {
    return !!(m && typeof m === 'object' && m.key && m.label && typeof m.sql === 'string' && m.sql.trim());
}

// Drops internal bookkeeping fields (those starting with "_") before persisting.
function stripInternal(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (!k.startsWith('_')) out[k] = v;
    return out;
}

const CONTRACT_RULES = `Rules (STRICT — queries are executed against the live database to check them):
- Postgres dialect. Each query MUST be a single read-only statement beginning with SELECT or WITH. No writes, no DDL, no semicolons joining statements.
- $1 is the as-of timestamp (a timestamptz = end of the reporting week). Every query MUST reference $1; cast it as $1::timestamptz. "This week" = the 7 days ending at $1; "prior week" = the 7 days before that.
- Reference ONLY tables and columns that appear in the schema below (use schema-qualified names as shown).
- Each metric's SQL returns EXACTLY ONE ROW with a column named "value", and optionally a column named "prior_value" (the same measure for the prior week; include it whenever a comparison makes sense so the report can show a delta).
- The trend's SQL returns ONE ROW PER DAY for the last 7 days, with a column named "label" (a short date label) plus one column per entry in "columns" (matched by the column's "key").
- PERFORMANCE (these tables may hold tens of millions of rows). Filter timestamp columns with a SARGABLE range so an index can be used: write "ts_col >= $1::timestamptz - INTERVAL '7 days' AND ts_col < $1::timestamptz". NEVER wrap the filtered/joined column in a function — no "date_trunc('day', ts_col) = ...", no "DATE(ts_col) = ...", no "ts_col::date = ..." in a WHERE or JOIN condition, because that forces a full table scan every run. For the daily trend specifically: first narrow orders/events to the 7-day window with a range predicate on the raw timestamp column, and ONLY THEN bucket them by day (e.g. group a pre-filtered subquery by date_trunc('day', ts_col)). Do not join a generated day series directly against an un-filtered table on a date_trunc() equality.`;

function buildGenerationMessages(schemaText) {
    return [
        {
            role: 'system',
            content: 'You are a senior analytics engineer. You design a weekly executive metrics report for a company, '
                + 'given only their database schema. You output STRICT JSON and nothing else.',
        },
        {
            role: 'user',
            content: `Here is the database schema:\n\n${schemaText}\n\n`
                + `Propose 3 to 6 of the most useful weekly business metrics for an executive report, plus one daily trend for a chart.\n\n`
                + `${CONTRACT_RULES}\n\n`
                + `Return JSON with EXACTLY this shape:\n`
                + `{\n`
                + `  "metrics": [\n`
                + `    {\n`
                + `      "key": "snake_case_id",\n`
                + `      "label": "Human Readable Label",\n`
                + `      "format": "currency" | "number" | "percent",\n`
                + `      "invertDelta": boolean,   // true when LOWER is better (e.g. churn, refunds)\n`
                + `      "deltaMode": "relative" | "absolute",  // "absolute" for rates/percentages (compare in points), else "relative"\n`
                + `      "sql": "WITH ... SELECT ... AS value, ... AS prior_value"\n`
                + `    }\n`
                + `  ],\n`
                + `  "trend": {\n`
                + `    "title": "Daily ... — Last 7 Days",\n`
                + `    "chartType": "bar",\n`
                + `    "chartSeries": "<one of the column keys below>",\n`
                + `    "columns": [ { "key": "snake_case", "label": "Label", "format": "currency|number|percent" } ],\n`
                + `    "sql": "SELECT to_char(day,'Mon DD') AS label, ... "\n`
                + `  }\n`
                + `}\n\n`
                + `Choose metrics that are meaningful for THIS schema. Output only the JSON object.`,
        },
    ];
}

function buildRepairMessages(schemaText, failures) {
    const list = failures.map((f, i) => (
        `${i + 1}. ${f.target}\n   error: ${f.reason}\n   current SQL:\n${f.sql}`
    )).join('\n\n');

    return [
        {
            role: 'system',
            content: 'You fix broken Postgres queries so they satisfy a strict contract. You output STRICT JSON and nothing else.',
        },
        {
            role: 'user',
            content: `Database schema:\n\n${schemaText}\n\n`
                + `${CONTRACT_RULES}\n\n`
                + `The following queries failed when run against the database. Fix each one. `
                + `If a query references a non-existent table/column, replace it with real ones from the schema. `
                + `If it returned the wrong shape, adjust the SELECT so the required column names (value / prior_value, or label + the column keys) are present.\n\n`
                + `${list}\n\n`
                + `Return JSON of the form: { "fixes": { "<key or 'trend'>": "<corrected SQL>", ... } }. `
                + `Include an entry only for the items above. Output only the JSON object.`,
        },
    ];
}

// ---- validation against the live DB --------------------------------------

async function validateMetricSql(runQuery, metric, asOf) {
    try {
        const { rows } = await runQuery(metric.sql, [asOf]);
        // Keep the first row so the caller can preview the ACTUAL value and lint
        // it (e.g. a percent that comes back as 4,201 — a raw count, not a rate).
        return { ...checkMetricShape(rows), sample: rows && rows[0] ? rows[0] : null };
    } catch (err) {
        return { ok: false, reason: describeError(err) };
    }
}

async function validateTrendSql(runQuery, trend, asOf) {
    try {
        const { rows } = await runQuery(trend.sql, [asOf]);
        return { ...checkTrendShape(rows, trend.columns), sample: { rowCount: rows.length, rows: rows.slice(0, 3) } };
    } catch (err) {
        return { ok: false, reason: describeError(err) };
    }
}

// ---- orchestrator ---------------------------------------------------------

// Returns { definition, dropped: [{target, reason}], schema: {tableCount, truncated} }.
// Effects (LLM, DB, introspection) are injectable via `deps` for testing.
async function generateReportDefinition({
    asOf = new Date(),
    model = generatorModel,
    maxRounds = 3,
    onProgress = () => {},
    introspectOptions = {},
    deps = {},
} = {}) {
    const _introspect = deps.introspectSchema || introspectSchema;
    const _format = deps.formatSchemaForPrompt || formatSchemaForPrompt;
    const _llm = deps.callLLM || callLLM;
    const _runQuery = deps.runReadOnly || runReadOnly;

    onProgress({ step: 'introspect' });
    const schema = await _introspect(introspectOptions);
    if (!schema.tables || schema.tables.length === 0) {
        throw new Error('No tables found in the database — is DATABASE_URL pointing at the right database?');
    }
    const schemaText = _format(schema);

    onProgress({ step: 'generate', model });
    const gen = await _llm({
        model, jsonMode: true, maxTokens: 4096, label: 'report generation',
        messages: buildGenerationMessages(schemaText),
    });
    let candidate;
    try {
        candidate = extractJson(gen.content);
    } catch (err) {
        // A 'length' finish means the JSON was cut off mid-object, which surfaces
        // here as a parse failure. Give the operator an actionable message.
        if (gen.finishReason === 'length') {
            throw new Error(
                "The model's response was cut off at the token limit before the report definition was complete. " +
                'This can happen on very large schemas — try a stronger GENERATOR_MODEL, or run setup against a database/user that exposes fewer tables.'
            );
        }
        throw err;
    }

    let metrics = (Array.isArray(candidate.metrics) ? candidate.metrics : [])
        .filter(isUsableMetric)
        .slice(0, MAX_METRICS);
    let trend = candidate.trend && candidate.trend.sql
        ? { chartType: 'bar', columns: [], ...candidate.trend }
        : null;

    if (metrics.length === 0) {
        throw new Error('The model did not return any usable metrics. Re-run setup, or set a stronger GENERATOR_MODEL.');
    }

    const dropped = [];
    for (let round = 0; round <= maxRounds; round++) {
        const failures = [];

        for (const m of metrics) {
            m._status = await validateMetricSql(_runQuery, m, asOf);
            if (!m._status.ok) {
                failures.push({ target: `metric "${m.key}"`, key: m.key, sql: m.sql, reason: m._status.reason });
            }
        }
        if (trend) {
            trend._status = await validateTrendSql(_runQuery, trend, asOf);
            if (!trend._status.ok) {
                failures.push({ target: 'trend', key: 'trend', sql: trend.sql, reason: trend._status.reason });
            }
        }

        onProgress({
            step: 'validate', round, failing: failures.length, total: metrics.length + (trend ? 1 : 0),
        });

        if (failures.length === 0) break;
        if (round === maxRounds) break; // out of budget — drop the stragglers below

        onProgress({ step: 'repair', round: round + 1, count: failures.length });
        let fixes;
        try {
            const rep = await _llm({
                model, jsonMode: true, maxTokens: 4096, label: `repair round ${round + 1}`,
                messages: buildRepairMessages(schemaText, failures),
            });
            fixes = extractJson(rep.content).fixes || {};
        } catch (err) {
            onProgress({ step: 'repair-error', reason: describeError(err) });
            break;
        }

        for (const m of metrics) {
            if (typeof fixes[m.key] === 'string' && fixes[m.key].trim()) m.sql = fixes[m.key];
        }
        if (trend && typeof fixes.trend === 'string' && fixes.trend.trim()) trend.sql = fixes.trend;
    }

    const goodMetrics = [];
    for (const m of metrics) {
        if (m._status && m._status.ok) goodMetrics.push(stripInternal(m));
        else dropped.push({ target: `metric "${m.key}"`, reason: (m._status && m._status.reason) || 'not validated' });
    }
    let goodTrend = null;
    if (trend) {
        if (trend._status && trend._status.ok) goodTrend = stripInternal(trend);
        else dropped.push({ target: 'trend', reason: (trend._status && trend._status.reason) || 'not validated' });
    }

    if (goodMetrics.length === 0) {
        throw new Error(
            `None of the generated metrics validated against your database after ${maxRounds} repair round(s).\n`
            + `Last errors:\n- ${dropped.map((d) => `${d.target}: ${d.reason}`).join('\n- ')}`,
        );
    }

    let definition = { version: 1, source: 'generated', metrics: goodMetrics, trend: goodTrend };

    // Align chartSeries with an actual column rather than discarding a good trend.
    if (definition.trend && Array.isArray(definition.trend.columns) && definition.trend.columns.length > 0) {
        const keys = definition.trend.columns.map((c) => c.key);
        if (!keys.includes(definition.trend.chartSeries)) definition.trend.chartSeries = keys[0];
    }

    // Final structural gate. If the trend is what's broken, drop it rather than
    // failing the whole run; otherwise surface the error.
    const structural = validateDefinition(definition);
    if (structural.length > 0) {
        const noTrend = { ...definition, trend: null };
        if (definition.trend && validateDefinition(noTrend).length === 0) {
            dropped.push({ target: 'trend', reason: `structural: ${structural.join('; ')}` });
            definition = noTrend;
        } else {
            throw new Error(`The generated definition is structurally invalid:\n- ${structural.join('\n- ')}`);
        }
    }

    // Advisory semantic review over what actually validated. `values` is keyed
    // by metric key with the raw dry-run row, so the linter can check the real
    // returned value and the caller can show it next to each metric. This is the
    // heart of the correctness gate: shape-valid ≠ semantically correct, so we
    // hand the approver the real numbers and the red flags we can detect.
    const values = {};
    for (const m of metrics) {
        if (m._status && m._status.ok && m._status.sample) values[m.key] = m._status.sample;
    }
    const warnings = lintDefinition(definition, { values });
    const preview = buildPreview(definition, values);

    return {
        definition,
        dropped,
        warnings,
        preview,
        schema: { tableCount: schema.tableCount, truncated: schema.truncated },
    };
}

module.exports = {
    generateReportDefinition,
    // exported for unit tests:
    extractJson,
    checkMetricShape,
    checkTrendShape,
    isUsableMetric,
    buildGenerationMessages,
    buildRepairMessages,
};
