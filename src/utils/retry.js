const logger = require('./logger');
const { describeError } = require('./describeError');

// Retries fn on failure with a linearly increasing delay between attempts.
// retries=1 means: try once, retry once more on failure (2 attempts total).
// shouldRetry(err) lets callers skip retrying errors that retrying can't fix
// (e.g. a 400 "invalid API key" — retrying just wastes time before falling
// back). Defaults to retrying everything, which is right for things like a
// momentary DB connection drop.
async function withRetry(fn, { retries = 1, delayMs = 2000, label = 'operation', shouldRetry = () => true } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < retries && shouldRetry(err)) {
                logger.warn(`${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delayMs}ms`, {
                    error: describeError(err),
                });
                await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
            } else {
                throw err;
            }
        }
    }
    throw lastErr;
}

module.exports = { withRetry };
