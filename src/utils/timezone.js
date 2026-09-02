// IANA time-zone validation and resolution for the report's "local" time.
//
// Why this matters: the cron schedule ("Monday 8am"), the daily-trend day
// buckets (date_trunc), and the "week ending" label are all only correct
// relative to a specific time zone. A container's clock is usually UTC, so
// without an explicit zone "8am Monday" and "which day an order falls on" drift
// from the company's actual local time. REPORT_TIMEZONE pins all three.

// A zone is valid iff Intl accepts it (throws RangeError otherwise).
function isValidTimezone(tz) {
    if (typeof tz !== 'string' || !tz.trim()) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

// Resolves the effective report zone:
//   - An explicitly-configured REPORT_TIMEZONE that's invalid is a hard error —
//     fail fast on a typo rather than silently reporting in the wrong zone.
//   - With nothing configured, use the system zone if usable, else the fallback.
function resolveTimezone({ requested, systemTz, fallback = 'UTC' } = {}) {
    if (requested) {
        if (isValidTimezone(requested)) return requested;
        throw new Error(
            `REPORT_TIMEZONE="${requested}" is not a valid IANA time zone `
            + '(e.g. "America/New_York", "Europe/London", "UTC").'
        );
    }
    if (systemTz && isValidTimezone(systemTz)) return systemTz;
    return fallback;
}

module.exports = { isValidTimezone, resolveTimezone };
