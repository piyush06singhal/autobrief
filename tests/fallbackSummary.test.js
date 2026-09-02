const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fallbackSummary } = require('../src/ai/summary');

test('fallbackSummary renders each metric with its formatted value and delta', () => {
    const text = fallbackSummary({
        metrics: [
            { label: 'Total Sales', value: 1500.5, format: 'currency', deltaPct: 12.5 },
            { label: 'New Signups', value: 42, format: 'number', deltaPct: -3 },
            { label: 'Churn Rate', value: 1.5, format: 'percent', deltaPct: null },
        ],
    });
    assert.match(text, /Total Sales: \$1,500\.5 \(\+12\.5% vs\. last week\)/);
    assert.match(text, /New Signups: 42 \(-3% vs\. last week\)/);
    assert.match(text, /Churn Rate: 1\.5%/);
    // No delta clause when there's no prior period (deltaPct null).
    assert.doesNotMatch(text, /Churn Rate: 1\.5% \(/);
});

test('fallbackSummary works for an arbitrary metric set (not just sales/signups/churn)', () => {
    const text = fallbackSummary({
        metrics: [
            { label: 'Active Patients', value: 320, format: 'number', deltaPct: 4 },
            { label: 'Avg Wait Time', value: 12.3, format: 'number', deltaPct: -8.1 },
        ],
    });
    assert.match(text, /Active Patients: 320 \(\+4% vs\. last week\)/);
    assert.match(text, /Avg Wait Time: 12\.3 \(-8\.1% vs\. last week\)/);
});

test('fallbackSummary handles an empty metric list without throwing', () => {
    const text = fallbackSummary({ metrics: [] });
    assert.match(text, /This week/);
});
