const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const { formatValue, formatDeltaLabel, deltaClass } = require('../utils/format');
const { reportTimezone } = require('../config/env');

// The report data is fully precomputed in JS below, so the template needs only
// one raw-output helper: embedding the trend as JSON for the client-side chart.
// `<` is escaped so a value containing "</script>" can't break out of the tag.
Handlebars.registerHelper('json', (value) =>
    JSON.stringify(value).replace(/</g, '\\u003c')
);

const templatePath = path.join(__dirname, '..', 'templates', 'report.hbs');
const cssPath = path.join(__dirname, '..', 'templates', 'assets', 'styles.css');
// chart.js's package "exports" map doesn't expose the UMD build or package.json,
// so resolve the package root from its main entry (dist/chart.cjs) instead.
const chartJsPackageRoot = path.dirname(path.dirname(require.resolve('chart.js')));
const chartJsPath = path.join(chartJsPackageRoot, 'dist', 'chart.umd.js');

// Renders the full standalone HTML report (CSS + Chart.js inlined, no network calls needed).
// `metrics` is the generic payload from getWeeklyMetrics: { asOf, metrics[], trend }.
function renderReportHtml({ metrics, executiveSummary }) {
    const template = Handlebars.compile(fs.readFileSync(templatePath, 'utf8'));
    const css = fs.readFileSync(cssPath, 'utf8');
    const chartJsSource = fs.readFileSync(chartJsPath, 'utf8');

    const asOfDate = new Date(metrics.asOf);

    // One stat card per metric. The arrow reflects the direction the number
    // moved (up/down); the color (via deltaClass) reflects whether that's good
    // or bad — so an inverted metric like churn can correctly show a green ▼.
    const statCards = metrics.metrics.map((m) => {
        const arrow = m.deltaPct > 0 ? '▲ ' : m.deltaPct < 0 ? '▼ ' : '';
        return {
            label: m.label,
            displayValue: formatValue(m.value, m.format),
            hasDelta: m.deltaPct !== null && m.deltaPct !== undefined,
            deltaText: arrow + formatDeltaLabel(m.deltaPct),
            deltaClass: deltaClass(m.deltaPct, m.invertDelta),
        };
    });

    // Flatten the trend into a plain header row + string cells so the template
    // doesn't need dynamic key lookups.
    let trend = null;
    if (metrics.trend && metrics.trend.rows.length > 0) {
        const { columns, rows, chartSeries } = metrics.trend;
        const chartColumn = columns.find((c) => c.key === chartSeries) || columns[0];
        trend = {
            title: metrics.trend.title,
            chartType: metrics.trend.chartType,
            chartSeries: chartColumn.key,
            chartSeriesLabel: chartColumn.label,
            rows, // raw {label, <key>: number} objects for the chart
            table: {
                headers: ['Day', ...columns.map((c) => c.label)],
                rows: rows.map((r) => [r.label, ...columns.map((c) => formatValue(r[c.key], c.format))]),
            },
        };
    }

    const data = {
        css,
        chartJsSource,
        executiveSummary,
        periodLabel: asOfDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: reportTimezone }),
        generatedAt: new Date().toLocaleString('en-US', { timeZone: reportTimezone, timeZoneName: 'short' }),
        metrics: statCards,
        trend,
        // Surfaced honestly on the report itself when a metric query failed and
        // was dropped, so a partial report never silently looks complete.
        notice: buildNotice(metrics.failedMetrics),
    };

    return template(data);
}

// Turns any dropped-metric records into a one-line reader-facing notice.
function buildNotice(failedMetrics) {
    if (!Array.isArray(failedMetrics) || failedMetrics.length === 0) return null;
    const names = failedMetrics.map((f) => f.label || f.key).filter(Boolean);
    if (names.length === 0) return null;
    return `Some metrics could not be calculated this period and were omitted: ${names.join(', ')}.`;
}

module.exports = { renderReportHtml };
