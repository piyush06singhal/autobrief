const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    generateReportDefinition,
    extractJson,
    checkMetricShape,
    checkTrendShape,
    isUsableMetric,
} = require('../src/ai/generateReportDefinition');

// ---- pure helpers ---------------------------------------------------------

test('extractJson parses a plain object, a fenced block, and JSON wrapped in prose', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJson('Here you go:\n{"a":3}\nHope that helps!'), { a: 3 });
});

test('extractJson throws on empty or non-JSON content', () => {
    assert.throws(() => extractJson(''), /empty/i);
    assert.throws(() => extractJson('no json here'), /No JSON object/i);
});

test('checkMetricShape requires exactly one row with a value column', () => {
    assert.equal(checkMetricShape([{ value: 1 }]).ok, true);
    assert.equal(checkMetricShape([{ value: 1, prior_value: 0 }]).ok, true);
    assert.equal(checkMetricShape([]).ok, false);
    const missing = checkMetricShape([{ total: 1 }]);
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /value/);
});

test('checkTrendShape requires label plus every declared column key', () => {
    const cols = [{ key: 'sales' }, { key: 'orders' }];
    assert.equal(checkTrendShape([{ label: 'Mon', sales: 1, orders: 2 }], cols).ok, true);
    assert.equal(checkTrendShape([], cols).ok, false);
    const missingCol = checkTrendShape([{ label: 'Mon', sales: 1 }], cols);
    assert.equal(missingCol.ok, false);
    assert.match(missingCol.reason, /orders/);
    const missingLabel = checkTrendShape([{ sales: 1, orders: 2 }], cols);
    assert.match(missingLabel.reason, /label/);
});

test('isUsableMetric requires key, label and non-empty sql', () => {
    assert.equal(isUsableMetric({ key: 'a', label: 'A', sql: 'SELECT 1 AS value' }), true);
    assert.equal(isUsableMetric({ key: 'a', label: 'A', sql: '   ' }), false);
    assert.equal(isUsableMetric({ label: 'A', sql: 'SELECT 1' }), false);
    assert.equal(isUsableMetric(null), false);
});

// ---- orchestrator repair loop (fakes for LLM + DB) ------------------------

function fakeIntrospect() {
    return { tables: [{ schema: 'public', name: 't', columns: [] }], tableCount: 1, truncated: false };
}

test('generateReportDefinition repairs a broken query and keeps everything that validates', async () => {
    let llmCalls = 0;
    const fakeLLM = async () => {
        llmCalls += 1;
        if (llmCalls === 1) {
            return {
                content: JSON.stringify({
                    metrics: [
                        { key: 'good', label: 'Good', format: 'number', sql: 'SELECT good' },
                        { key: 'bad', label: 'Bad', format: 'currency', sql: 'SELECT bad' },
                    ],
                    trend: {
                        title: 'T', chartType: 'bar', chartSeries: 'v',
                        columns: [{ key: 'v', label: 'V', format: 'number' }], sql: 'TREND bad',
                    },
                }),
            };
        }
        return { content: JSON.stringify({ fixes: { bad: 'SELECT fixedbad', trend: 'TREND fixed' } }) };
    };

    const fakeRun = async (sql) => {
        switch (sql) {
            case 'SELECT good': return { rows: [{ value: 1 }] };
            case 'SELECT bad': return { rows: [{}] };            // missing "value"
            case 'SELECT fixedbad': return { rows: [{ value: 2 }] };
            case 'TREND bad': return { rows: [{ label: 'x' }] };  // missing "v"
            case 'TREND fixed': return { rows: [{ label: 'x', v: 5 }] };
            default: throw new Error(`unexpected sql: ${sql}`);
        }
    };

    const { definition, dropped } = await generateReportDefinition({
        maxRounds: 3,
        deps: {
            introspectSchema: fakeIntrospect,
            formatSchemaForPrompt: () => 'schema',
            callLLM: fakeLLM,
            runReadOnly: fakeRun,
        },
    });

    assert.equal(llmCalls, 2, 'one generation call + one repair round');
    assert.equal(definition.metrics.length, 2);
    assert.ok(definition.trend, 'trend survived after repair');
    assert.equal(dropped.length, 0);
});

test('generateReportDefinition drops a query that never validates but keeps the rest', async () => {
    const fakeLLM = async () => ({
        content: JSON.stringify({
            metrics: [
                { key: 'good', label: 'Good', format: 'number', sql: 'SELECT good' },
                { key: 'hopeless', label: 'Hopeless', format: 'number', sql: 'SELECT hopeless' },
            ],
        }),
    });
    // The repair "fix" is still broken, so hopeless never validates.
    const fakeRun = async (sql) => {
        if (sql === 'SELECT good') return { rows: [{ value: 1 }] };
        return { rows: [{}] }; // hopeless always missing "value"
    };

    const { definition, dropped } = await generateReportDefinition({
        maxRounds: 1,
        deps: {
            introspectSchema: fakeIntrospect,
            formatSchemaForPrompt: () => 'schema',
            callLLM: fakeLLM,
            runReadOnly: fakeRun,
        },
    });

    assert.equal(definition.metrics.length, 1);
    assert.equal(definition.metrics[0].key, 'good');
    assert.ok(dropped.some((d) => /hopeless/.test(d.target)));
});

test('generateReportDefinition throws when zero metrics validate', async () => {
    const fakeLLM = async () => ({
        content: JSON.stringify({ metrics: [{ key: 'x', label: 'X', sql: 'SELECT x' }] }),
    });
    const fakeRun = async () => ({ rows: [{}] }); // never has "value"

    await assert.rejects(
        generateReportDefinition({
            maxRounds: 1,
            deps: {
                introspectSchema: fakeIntrospect,
                formatSchemaForPrompt: () => 'schema',
                callLLM: fakeLLM,
                runReadOnly: fakeRun,
            },
        }),
        /None of the generated metrics validated/,
    );
});

test('generateReportDefinition returns a value preview and flags a not-time-bounded metric', async () => {
    const fakeLLM = async () => ({
        content: JSON.stringify({
            metrics: [
                { key: 'sales', label: 'Total Sales', format: 'currency', sql: 'SELECT 100 AS value, 90 AS prior_value WHERE t >= $1' },
                { key: 'alltime', label: 'Registered Accounts', format: 'number', sql: 'SELECT 5 AS value' },
            ],
        }),
    });
    const fakeRun = async (sql) => (/\$1/.test(sql)
        ? { rows: [{ value: 100, prior_value: 90 }] }
        : { rows: [{ value: 5 }] });

    const { preview, warnings } = await generateReportDefinition({
        maxRounds: 0,
        deps: {
            introspectSchema: fakeIntrospect,
            formatSchemaForPrompt: () => 'schema',
            callLLM: fakeLLM,
            runReadOnly: fakeRun,
        },
    });

    // The preview carries the ACTUAL returned numbers, keyed by metric key.
    assert.equal(preview.metrics.sales.value, 100);
    assert.equal(preview.metrics.sales.priorValue, 90);
    assert.equal(preview.metrics.alltime.value, 5);

    // The all-time metric (no $1) is flagged; the time-bounded one is not.
    const notBounded = warnings.filter((w) => w.code === 'not_time_bounded');
    assert.ok(notBounded.some((w) => /alltime/.test(w.target)), 'alltime should be flagged');
    assert.ok(!notBounded.some((w) => /sales/.test(w.target)), 'sales should not be flagged');
});
