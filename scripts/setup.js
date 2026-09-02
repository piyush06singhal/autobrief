// `npm run setup` — the one command a new company runs to make this their own.
//
// It points at whatever DATABASE_URL is set, has the AI read the schema, propose
// weekly metrics, generate + self-validate the SQL against the live database,
// then shows you exactly what it came up with and asks for a one-time approval
// before writing output/report-definition.json. After that the weekly pipeline
// runs autonomously on your data — no hand-written SQL, no code edits.
//
// Re-runnable any time (e.g. after schema changes). Non-interactive approval:
//   npm run setup -- --yes      (or SETUP_AUTO_APPROVE=1)

const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { databaseUrl, generatorModel } = require('../src/config/env');
const { isLlmConfigured } = require('../src/ai/llmClient');
const { generateReportDefinition } = require('../src/ai/generateReportDefinition');
const { saveReportDefinition, definitionPath } = require('../src/config/reportDefinition');
const { closePool } = require('../src/db/pool');
const { describeError } = require('../src/utils/describeError');
const { formatValue } = require('../src/utils/format');
const { computeDelta } = require('../src/utils/pctChange');

const AUTO_APPROVE = process.argv.includes('--yes') || process.env.SETUP_AUTO_APPROVE === '1';

function indent(text, spaces = 6) {
    const pad = ' '.repeat(spaces);
    return String(text).split('\n').map((l) => pad + l).join('\n');
}

// Renders "→ returns $47,201, prior $44,980 (+4.9% vs prior)" — the actual
// numbers the query produced, so an obviously-wrong value is caught by eye.
function previewLine(m, p) {
    if (!p || p.value === null || p.value === undefined) return '      → (no value returned)';
    let line = `      → returns ${formatValue(p.value, m.format)}`;
    if (p.priorValue !== null && p.priorValue !== undefined) {
        const delta = computeDelta(p.value, p.priorValue, m.deltaMode);
        const unit = m.deltaMode === 'absolute' ? '' : '%';
        line += `, prior ${formatValue(p.priorValue, m.format)} (${delta >= 0 ? '+' : ''}${delta}${unit} vs prior)`;
    }
    return line;
}

function printDefinition(definition, preview = { metrics: {} }) {
    console.log(`\nProposed metrics (${definition.metrics.length}):\n`);
    definition.metrics.forEach((m, i) => {
        const flags = [
            `format=${m.format || 'number'}`,
            m.invertDelta ? 'lower-is-better' : null,
            m.deltaMode === 'absolute' ? 'delta=absolute' : null,
        ].filter(Boolean).join(', ');
        console.log(`  ${i + 1}. ${m.label}  [${m.key}]  (${flags})`);
        console.log(previewLine(m, preview.metrics && preview.metrics[m.key]));
        console.log(indent(m.sql));
        console.log('');
    });

    if (definition.trend) {
        const cols = definition.trend.columns.map((c) => `${c.key}(${c.format || 'number'})`).join(', ');
        console.log(`Trend: ${definition.trend.title}  chart=${definition.trend.chartType} on "${definition.trend.chartSeries}"`);
        console.log(`  columns: ${cols}`);
        console.log(indent(definition.trend.sql));
        console.log('');
    } else {
        console.log('Trend: (none)\n');
    }
}

// Advisory semantic flags. These never block approval — they point the reviewer
// at the parts most likely to be measuring the wrong thing.
function printWarnings(warnings = []) {
    if (warnings.length === 0) {
        console.log('✓ No semantic red flags detected — but still sanity-check the numbers above.\n');
        return;
    }
    console.log(`⚠  ${warnings.length} thing(s) worth a look (advisory — you can still approve):`);
    for (const w of warnings) console.log(`   • ${w.message}`);
    console.log('');
}

function progress(evt) {
    switch (evt.step) {
        case 'introspect':
            console.log('• Reading your database schema…');
            break;
        case 'generate':
            console.log(`• Asking ${evt.model} to propose metrics…`);
            break;
        case 'validate':
            console.log(evt.failing === 0
                ? `• All ${evt.total} quer${evt.total === 1 ? 'y' : 'ies'} validated against your database.`
                : `• Validation round ${evt.round}: ${evt.failing}/${evt.total} quer${evt.failing === 1 ? 'y needs' : 'ies need'} fixing.`);
            break;
        case 'repair':
            console.log(`• Asking the model to fix ${evt.count} quer${evt.count === 1 ? 'y' : 'ies'}…`);
            break;
        case 'repair-error':
            console.log(`• Could not get fixes from the model: ${evt.reason}`);
            break;
        default:
            break;
    }
}

async function confirm(question) {
    if (AUTO_APPROVE) {
        console.log(`${question} y (auto-approved)`);
        return true;
    }
    if (!stdin.isTTY) {
        console.log('\nNot running interactively and --yes was not passed — not writing anything.');
        console.log('Re-run with:  npm run setup -- --yes');
        return false;
    }
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
        const answer = (await rl.question(`${question} `)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
    } finally {
        rl.close();
    }
}

async function main() {
    console.log('=== Report setup ===\n');

    if (!databaseUrl) {
        console.error('✗ DATABASE_URL is not set. Copy .env.example to .env and set it to your database,');
        console.error('  ideally a READ-ONLY role (see the README safety notes), then re-run: npm run setup');
        process.exit(1);
    }
    if (!isLlmConfigured()) {
        console.error('✗ No LLM API key configured. Set GROQ_API_KEY in .env (or LLM_BASE_URL + a compatible key),');
        console.error('  then re-run: npm run setup');
        process.exit(1);
    }

    console.log(`Database: ${databaseUrl.replace(/:[^:@]*@/, ':****@')}`);
    console.log(`Model:    ${generatorModel}\n`);

    let result;
    try {
        result = await generateReportDefinition({ onProgress: progress });
    } catch (err) {
        console.error(`\n✗ Setup could not generate a working definition:\n${describeError(err)}`);
        await closePool();
        process.exit(1);
    }

    const { definition, dropped, schema, warnings, preview } = result;
    console.log(`\nInspected ${schema.tableCount} table(s)${schema.truncated ? ' (some omitted for size)' : ''}.`);

    printDefinition(definition, preview);

    if (dropped.length > 0) {
        console.log('Note — these were dropped because they could not be validated:');
        for (const d of dropped) console.log(`  - ${d.target}: ${d.reason}`);
        console.log('');
    }

    printWarnings(warnings);

    console.log('⚠  These queries are guaranteed to RUN and return the right shape — not to measure the');
    console.log('   semantically correct thing. Check the returned values and the flags above before approving.\n');

    const approved = await confirm('Save this as your report definition? [y/N]');
    if (!approved) {
        console.log('\nNothing written. Re-run `npm run setup` any time, or edit metrics later in the admin dashboard.');
        await closePool();
        process.exit(0);
    }

    try {
        saveReportDefinition({ ...definition, source: 'generated' });
        console.log(`\n✓ Saved to ${definitionPath}`);
        console.log('\nNext steps:');
        console.log('  npm run db:validate     # re-check the saved queries any time');
        console.log('  npm run report:run      # generate a real report on your data now');
        console.log('  docker compose --profile scheduler up -d db scheduler admin   # autonomous weekly delivery');
    } catch (err) {
        console.error(`\n✗ Failed to save definition: ${describeError(err)}`);
        await closePool();
        process.exit(1);
    }

    await closePool();
    process.exit(0);
}

main();
