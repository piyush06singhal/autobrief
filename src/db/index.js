const { runReadOnly } = require('./safeQuery');
const { closePool } = require('./pool');
const { getReportDefinition } = require('../config/reportDefinition');
const { computeDelta } = require('../utils/pctChange');
const { describeError } = require('../utils/describeError');
const logger = require('../utils/logger');

// Runs one scalar metric query and shapes its single row into the generic
// metric object the renderer and summary consume.
async function runMetric(metric, asOf) {
    const { rows } = await runReadOnly(metric.sql, [asOf]);
    const row = rows[0] || {};

    // Coerce null -> 0 (e.g. a churn rate with no active users divides to NULL)
    // so a metric always has a number to display, matching the original code.
    const value = row.value == null ? 0 : Number(row.value);
    const priorValue = row.prior_value == null ? null : Number(row.prior_value);
    const deltaPct = priorValue == null ? null : computeDelta(value, priorValue, metric.deltaMode);

    return {
        key: metric.key,
        label: metric.label,
        value,
        priorValue,
        deltaPct,
        format: metric.format,
        invertDelta: metric.invertDelta,
    };
}

// Runs the trend query and coerces each declared column to a number per row.
async function runTrend(trend, asOf) {
    const { rows } = await runReadOnly(trend.sql, [asOf]);
    return {
        title: trend.title,
        chartType: trend.chartType,
        chartSeries: trend.chartSeries,
        columns: trend.columns,
        rows: rows.map((row) => {
            const out = { label: row.label };
            for (const col of trend.columns) {
                out[col.key] = row[col.key] == null ? 0 : Number(row[col.key]);
            }
            return out;
        }),
    };
}

// Aggregates every metric in the active report definition into one JSON payload.
// The shape is now generic (a list of metrics + an optional trend) rather than
// the old fixed sales/signups/churn object, so the same pipeline works for any
// company's definition.
//
// Resilience: metrics run independently. If one query fails (data drift, a
// transient DB error), it's logged and dropped rather than sinking the whole
// report — the remaining metrics still go out, and `failedMetrics` records what
// was lost so the summary/alert can flag an incomplete report. Only when *every*
// metric fails do we throw, because then there's no report worth sending.
async function getWeeklyMetrics(asOf = new Date()) {
    const { definition } = getReportDefinition();

    const settled = await Promise.allSettled(
        definition.metrics.map((m) => runMetric(m, asOf))
    );

    const metrics = [];
    const failedMetrics = [];
    settled.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            metrics.push(result.value);
        } else {
            const meta = definition.metrics[i] || {};
            const reason = describeError(result.reason);
            logger.error('Metric query failed; dropping it from the report', {
                metricKey: meta.key,
                reason,
            });
            failedMetrics.push({ key: meta.key, label: meta.label, reason });
        }
    });

    if (metrics.length === 0) {
        const detail = failedMetrics.map((f) => `${f.key}: ${f.reason}`).join('; ');
        throw new Error(`Every metric query failed — no report to send. ${detail}`);
    }

    // A failing trend just drops the chart; the metric cards are the core of the
    // report and are worth delivering on their own.
    let trend = null;
    if (definition.trend) {
        try {
            trend = await runTrend(definition.trend, asOf);
        } catch (err) {
            logger.error('Trend query failed; report will render without the chart', {
                reason: describeError(err),
            });
        }
    }

    return {
        asOf: asOf.toISOString(),
        metrics,
        trend,
        failedMetrics,
    };
}

module.exports = { getWeeklyMetrics, closePool };
