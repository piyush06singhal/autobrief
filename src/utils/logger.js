// Emits one JSON object per line — standard structured-log format that a
// real log aggregator (Docker's json-file driver, CloudWatch, Loki, etc.)
// can parse directly, instead of free-text lines nobody but a human can grep.
function log(level, message, meta = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...meta,
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
        console.error(line);
    } else if (level === 'warn') {
        console.warn(line);
    } else {
        console.log(line);
    }
}

module.exports = {
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
};
