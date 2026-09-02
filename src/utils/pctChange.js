// Percentage change of `current` vs `prior`, rounded to one decimal place.
// If there's no prior value to compare against, treat any positive current as
// +100% and zero as 0% (rather than dividing by zero). Shared by the metrics
// runner and the fallback summary so they can't drift apart.
function pctChange(current, prior) {
    if (!prior) return current > 0 ? 100 : 0;
    return Math.round(((current - prior) / prior) * 1000) / 10;
}

// The delta shown on a metric card, in one of two modes:
//   'relative' (default) — percentage change, e.g. sales +12.5%.
//   'absolute'           — raw difference, e.g. a churn rate moving from 2.0 to
//                          2.5 is +0.5 (percentage points), not +25%. Rates are
//                          almost always compared this way.
function computeDelta(current, prior, mode = 'relative') {
    if (mode === 'absolute') return Math.round((current - prior) * 10) / 10;
    return pctChange(current, prior);
}

module.exports = { pctChange, computeDelta };
