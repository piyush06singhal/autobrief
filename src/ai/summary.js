const { groqModel } = require('../config/env');
const { callLLM, isLlmConfigured } = require('./llmClient');
const { formatValue } = require('../utils/format');
const logger = require('../utils/logger');

// One-line templated summary, used when no LLM is configured or the call fails.
// Iterates whatever metrics the active definition produced, so it works for any
// company's report, not just the original sales/signups/churn set.
function fallbackSummary(metrics) {
    const parts = metrics.metrics.map((m) => {
        const value = formatValue(m.value, m.format);
        const delta = (m.deltaPct === null || m.deltaPct === undefined)
            ? ''
            : ` (${m.deltaPct >= 0 ? '+' : ''}${m.deltaPct}% vs. last week)`;
        return `${m.label}: ${value}${delta}`;
    });
    return `This week — ${parts.join('; ')}.`;
}

// Turns the raw metrics JSON into a short narrative summary for executives.
// Falls back to a templated one-liner if no LLM API key is configured, or on any API error.
async function generateExecutiveSummary(metrics) {
    if (!isLlmConfigured()) {
        logger.warn('GROQ_API_KEY not set — using templated fallback summary instead of AI-generated one.');
        return fallbackSummary(metrics);
    }

    try {
        const { content, finishReason } = await callLLM({
            model: groqModel,
            maxTokens: 400,
            reasoningEffort: 'low',
            retries: 1,
            label: 'Groq summary',
            messages: [
                {
                    role: 'user',
                    content: `You are writing the opening paragraph of a weekly business report for company executives. `
                        + `Given this week's metrics as JSON, write at most 2 short sentences (under 45 words total) `
                        + `highlighting what changed and any notable trend or anomaly. `
                        + `Plain prose, no headers, no bullet points, no markdown.\n\n${JSON.stringify(metrics, null, 2)}`,
                },
            ],
        });

        const text = content?.trim();
        if (!text) {
            logger.warn('Groq returned no summary text, using fallback', { finishReason });
            return fallbackSummary(metrics);
        }

        return text;
    } catch (err) {
        logger.error('Groq executive summary generation failed, using fallback', { error: err.message });
        return fallbackSummary(metrics);
    }
}

module.exports = { generateExecutiveSummary, fallbackSummary };
