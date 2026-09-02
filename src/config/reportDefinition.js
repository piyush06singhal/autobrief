const fs = require('fs');
const path = require('path');
const env = require('./env');

const DEFAULT_DEFINITION_PATH = path.join(__dirname, '..', '..', 'output', 'report-definition.json');

// The report is driven entirely by this definition: which metrics to compute,
// the SQL for each, and how to display them. `npm run setup` generates one for
// a real database and writes it to output/report-definition.json (the same
// shared, Docker-mounted volume settings.json / run-log.json already use).
//
// When no file exists yet, this built-in DEMO_DEFINITION runs — it reproduces
// the original hardcoded sales / signups / churn report against the seeded demo
// schema, so `docker compose up -d db && npm run report:run` still works with
// zero configuration.
//
// The query contract every definition must satisfy:
//   - Each metric `sql` returns ONE row with a `value` column and an optional
//     `prior_value` column (omit prior_value and the delta is simply hidden).
//   - The trend `sql` returns one row per point with a `label` column plus one
//     column per entry in `columns` (matched by `key`).
//   - Both take $1 = the as-of timestamp (end of the reporting week).
const DEMO_DEFINITION = {
    version: 1,
    generatedAt: null,
    source: 'demo',
    metrics: [
        {
            key: 'total_sales',
            label: 'Total Sales',
            format: 'currency',
            invertDelta: false,
            deltaMode: 'relative',
            sql: `WITH current_week AS (
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM orders
    WHERE created_at >= $1::TIMESTAMPTZ - INTERVAL '7 days'
      AND created_at < $1::TIMESTAMPTZ
),
previous_week AS (
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM orders
    WHERE created_at >= $1::TIMESTAMPTZ - INTERVAL '14 days'
      AND created_at < $1::TIMESTAMPTZ - INTERVAL '7 days'
)
SELECT current_week.total AS value, previous_week.total AS prior_value
FROM current_week, previous_week`,
        },
        {
            key: 'new_signups',
            label: 'New Signups',
            format: 'number',
            invertDelta: false,
            deltaMode: 'relative',
            sql: `WITH current_week AS (
    SELECT COUNT(*) AS signups
    FROM users
    WHERE signed_up_at >= $1::TIMESTAMPTZ - INTERVAL '7 days'
      AND signed_up_at < $1::TIMESTAMPTZ
),
previous_week AS (
    SELECT COUNT(*) AS signups
    FROM users
    WHERE signed_up_at >= $1::TIMESTAMPTZ - INTERVAL '14 days'
      AND signed_up_at < $1::TIMESTAMPTZ - INTERVAL '7 days'
)
SELECT current_week.signups AS value, previous_week.signups AS prior_value
FROM current_week, previous_week`,
        },
        {
            key: 'churn_rate',
            label: 'Churn Rate',
            format: 'percent',
            invertDelta: true,
            // A rate is compared in percentage points (2.0 -> 2.5 is +0.5), not
            // as a relative % change.
            deltaMode: 'absolute',
            sql: `WITH active_at_week_start AS (
    SELECT COUNT(*) AS active_count
    FROM users
    WHERE signed_up_at < $1::TIMESTAMPTZ - INTERVAL '7 days'
      AND (churned_at IS NULL OR churned_at >= $1::TIMESTAMPTZ - INTERVAL '7 days')
),
active_at_prior_week_start AS (
    SELECT COUNT(*) AS active_count
    FROM users
    WHERE signed_up_at < $1::TIMESTAMPTZ - INTERVAL '14 days'
      AND (churned_at IS NULL OR churned_at >= $1::TIMESTAMPTZ - INTERVAL '14 days')
),
churned_this_week AS (
    SELECT COUNT(*) AS churn_count
    FROM users
    WHERE churned_at >= $1::TIMESTAMPTZ - INTERVAL '7 days'
      AND churned_at < $1::TIMESTAMPTZ
),
churned_prior_week AS (
    SELECT COUNT(*) AS churn_count
    FROM users
    WHERE churned_at >= $1::TIMESTAMPTZ - INTERVAL '14 days'
      AND churned_at < $1::TIMESTAMPTZ - INTERVAL '7 days'
)
SELECT
    ROUND(churned_this_week.churn_count::NUMERIC / NULLIF(active_at_week_start.active_count, 0) * 100, 2)       AS value,
    ROUND(churned_prior_week.churn_count::NUMERIC / NULLIF(active_at_prior_week_start.active_count, 0) * 100, 2) AS prior_value
FROM churned_this_week, active_at_week_start, churned_prior_week, active_at_prior_week_start`,
        },
    ],
    trend: {
        title: 'Daily Sales — Last 7 Days',
        chartType: 'bar',
        chartSeries: 'sales',
        columns: [
            { key: 'orders', label: 'Orders', format: 'number' },
            { key: 'sales', label: 'Sales', format: 'currency' },
        ],
        // Range-filter orders to the charted window FIRST (a sargable predicate
        // that uses the created_at index), THEN bucket by day. The obvious
        // alternative — joining on `date_trunc('day', orders.created_at) =
        // days.day` — wraps the column in a function, so the index can't be used
        // and Postgres sequentially scans the ENTIRE orders table every run.
        // Measured on 5M rows: ~24x slower, and unbounded as the table grows.
        // The generator prompt requires this same range-filter-first shape.
        sql: `WITH days AS (
    SELECT generate_series(
        date_trunc('day', $1::TIMESTAMPTZ - INTERVAL '6 days'),
        date_trunc('day', $1::TIMESTAMPTZ),
        INTERVAL '1 day'
    ) AS day
),
recent_orders AS (
    SELECT id, amount, date_trunc('day', created_at) AS day
    FROM orders
    WHERE created_at >= date_trunc('day', $1::TIMESTAMPTZ - INTERVAL '6 days')
      AND created_at <  date_trunc('day', $1::TIMESTAMPTZ) + INTERVAL '1 day'
)
SELECT
    to_char(days.day, 'Mon DD')            AS label,
    COUNT(recent_orders.id)                AS orders,
    COALESCE(SUM(recent_orders.amount), 0) AS sales
FROM days
LEFT JOIN recent_orders ON recent_orders.day = days.day
GROUP BY days.day
ORDER BY days.day`,
    },
};

const VALID_FORMATS = new Set(['currency', 'number', 'percent']);

// Structural validation — enough to catch a malformed definition (hand-edited
// in the admin UI, or a bad LLM generation) before it reaches the pipeline.
// Does NOT run the SQL; that's validate-db.js / the setup validation loop.
function validateDefinition(def) {
    const errors = [];
    if (!def || typeof def !== 'object') return ['Definition must be an object.'];

    if (!Array.isArray(def.metrics) || def.metrics.length === 0) {
        errors.push('Definition must have a non-empty "metrics" array.');
    } else {
        def.metrics.forEach((m, i) => {
            const where = `metrics[${i}]${m && m.key ? ` ("${m.key}")` : ''}`;
            if (!m || typeof m !== 'object') return errors.push(`${where} must be an object.`);
            if (!m.key) errors.push(`${where} is missing "key".`);
            if (!m.label) errors.push(`${where} is missing "label".`);
            if (!m.sql || typeof m.sql !== 'string') errors.push(`${where} is missing "sql".`);
            if (m.format && !VALID_FORMATS.has(m.format)) {
                errors.push(`${where} has invalid format "${m.format}" (expected currency|number|percent).`);
            }
        });
    }

    if (def.trend != null) {
        if (typeof def.trend !== 'object') {
            errors.push('"trend" must be an object (or omitted).');
        } else {
            if (!def.trend.sql) errors.push('trend is missing "sql".');
            if (!Array.isArray(def.trend.columns) || def.trend.columns.length === 0) {
                errors.push('trend must have a non-empty "columns" array.');
            } else if (def.trend.chartSeries && !def.trend.columns.some((c) => c.key === def.trend.chartSeries)) {
                errors.push(`trend.chartSeries "${def.trend.chartSeries}" does not match any trend column key.`);
            }
        }
    }

    return errors;
}

// Fills in optional fields so downstream code doesn't have to null-check them.
function normalizeDefinition(def) {
    return {
        version: def.version ?? 1,
        generatedAt: def.generatedAt ?? null,
        source: def.source ?? 'custom',
        metrics: def.metrics.map((m) => ({
            key: m.key,
            label: m.label,
            format: m.format || 'number',
            invertDelta: !!m.invertDelta,
            deltaMode: m.deltaMode === 'absolute' ? 'absolute' : 'relative',
            sql: m.sql,
        })),
        trend: def.trend
            ? {
                title: def.trend.title || 'Trend',
                chartType: def.trend.chartType || 'bar',
                chartSeries: def.trend.chartSeries || (def.trend.columns[0] && def.trend.columns[0].key),
                columns: def.trend.columns.map((c) => ({
                    key: c.key,
                    label: c.label || c.key,
                    format: VALID_FORMATS.has(c.format) ? c.format : 'number',
                })),
                sql: def.trend.sql,
            }
            : null,
    };
}

// Factory so tests can point at a temp file. envDefaults is reserved for future
// use (e.g. a configured default definition path); the demo default is used
// whenever no saved definition exists.
function createReportDefinition(definitionPath = DEFAULT_DEFINITION_PATH, demoDefault = DEMO_DEFINITION) {
    // Returns { definition, source }: 'saved' when a valid file was read,
    // 'demo' when falling back to the built-in demo definition.
    function getReportDefinition() {
        if (fs.existsSync(definitionPath)) {
            try {
                const saved = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
                const errors = validateDefinition(saved);
                if (errors.length === 0) {
                    return { definition: normalizeDefinition(saved), source: 'saved' };
                }
            } catch {
                // Fall through to the demo default on parse/validation failure.
            }
        }
        return { definition: normalizeDefinition(demoDefault), source: 'demo' };
    }

    function saveReportDefinition(def) {
        const errors = validateDefinition(def);
        if (errors.length > 0) {
            throw new Error(`Cannot save invalid report definition:\n- ${errors.join('\n- ')}`);
        }
        const normalized = normalizeDefinition({ ...def, generatedAt: def.generatedAt || new Date().toISOString() });
        const dir = path.dirname(definitionPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(definitionPath, JSON.stringify(normalized, null, 2));
        return normalized;
    }

    function definitionExists() {
        return fs.existsSync(definitionPath);
    }

    return { getReportDefinition, saveReportDefinition, definitionExists, definitionPath };
}

module.exports = {
    ...createReportDefinition(),
    createReportDefinition,
    validateDefinition,
    normalizeDefinition,
    DEMO_DEFINITION,
    DEFAULT_DEFINITION_PATH,
};
