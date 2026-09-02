// Formats a numeric metric value for display according to its declared format.
// One place so the PDF (renderHtml) and the fallback summary render a value
// identically. `format` is one of: 'currency' | 'percent' | 'number'.
function formatNumber(value) {
    return Number(value).toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
}

function formatValue(value, format) {
    const n = formatNumber(value);
    if (format === 'currency') return `$${n}`;
    if (format === 'percent') return `${n}%`;
    return n;
}

// The "+3.2% vs. last week" style delta label. `delta` is null when there's no
// prior period to compare against, in which case there's nothing to show.
function formatDeltaLabel(delta) {
    if (delta === null || delta === undefined) return '';
    return `${delta >= 0 ? '+' : ''}${delta}% vs. last week`;
}

// Which CSS class the delta gets: green when the change is good, red when bad,
// grey when flat. `invert` flips it for metrics where down is good (e.g. churn).
function deltaClass(delta, invert = false) {
    if (delta === null || delta === undefined || delta === 0) return 'neutral';
    const isGood = invert ? delta < 0 : delta > 0;
    return isGood ? 'positive' : 'negative';
}

module.exports = { formatNumber, formatValue, formatDeltaLabel, deltaClass };
