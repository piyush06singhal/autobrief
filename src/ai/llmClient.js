const { groqApiKey, groqModel, llmBaseUrl } = require('../config/env');
const { withRetry } = require('../utils/retry');

// A minimal OpenAI-compatible chat client, shared by the executive-summary
// writer (src/ai/summary.js) and the report-definition generator
// (src/ai/generateReportDefinition.js). Works with Groq (the default), OpenAI,
// or any compatible endpoint via LLM_BASE_URL.

// Retry network-level failures and 429/5xx (transient); don't retry 4xx like an
// invalid model name or a billing error — a second attempt won't fix those.
function isTransientLlmError(err) {
    const status = err.status;
    return status === undefined || status === 429 || status >= 500;
}

// True when an API key is configured. Callers that have a non-LLM fallback
// (the executive summary) check this to avoid a guaranteed-failing call.
function isLlmConfigured() {
    return !!groqApiKey;
}

// Makes one chat-completions call and returns { content, finishReason, raw }.
// Throws if no API key is set, or on a non-2xx response after retries.
async function callLLM({
    messages,
    model = groqModel,
    maxTokens = 800,
    jsonMode = false,
    reasoningEffort,
    retries = 1,
    label = 'LLM call',
} = {}) {
    if (!groqApiKey) {
        throw new Error('No LLM API key configured — set GROQ_API_KEY in .env.');
    }

    const body = { model, max_tokens: maxTokens, messages };
    // response_format json_object asks the model to emit strict JSON — used by
    // the generator. Supported by Groq and OpenAI; harmless if a proxy ignores it.
    if (jsonMode) body.response_format = { type: 'json_object' };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;

    async function once() {
        const response = await fetch(`${llmBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            const err = new Error(`LLM API returned ${response.status}: ${errorBody}`);
            err.status = response.status;
            throw err;
        }

        return response.json();
    }

    const data = await withRetry(once, {
        retries, delayMs: 2000, label, shouldRetry: isTransientLlmError,
    });

    return {
        content: data.choices?.[0]?.message?.content ?? '',
        finishReason: data.choices?.[0]?.finish_reason,
        raw: data,
    };
}

module.exports = { callLLM, isLlmConfigured, isTransientLlmError };
