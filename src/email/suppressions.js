const { sendgridApiKey } = require('../config/env');
const logger = require('../utils/logger');

const SENDGRID_API_BASE = 'https://api.sendgrid.com';

// The four SendGrid suppression groups that mean "do not keep mailing this
// address". SendGrid itself will drop a send to a suppressed address, but the
// sender must clean their own list — continuing to submit known-bad addresses
// degrades sender reputation and junks mail to everyone else.
//   bounce         - the receiving server hard-rejected the address
//   spam_report    - the recipient marked a previous mail as spam (a complaint)
//   block          - a soft/transient block (full mailbox, temporary reject)
//   invalid_email  - malformed / non-existent address
const SUPPRESSION_GROUPS = [
    { type: 'bounce', path: '/v3/suppression/bounces' },
    { type: 'spam_report', path: '/v3/suppression/spam_reports' },
    { type: 'block', path: '/v3/suppression/blocks' },
    { type: 'invalid_email', path: '/v3/suppression/invalid_emails' },
];

// Fetches every suppressed address from SendGrid, normalized to
// { email, type, reason, createdAt }. Best-effort by contract: a missing key or
// any network/API failure returns what it has (often nothing) and never throws,
// so a suppression-API hiccup can never block the weekly report from sending.
// `fetchImpl` is injectable so the happy/error paths are unit-testable offline.
async function fetchSuppressions({
    apiKey = sendgridApiKey,
    fetchImpl = fetch,
    baseUrl = SENDGRID_API_BASE,
    timeoutMs = 8000,
} = {}) {
    if (!apiKey) return { ok: false, reason: 'no_api_key', suppressions: [] };

    const suppressions = [];
    let anyFailed = false;
    let sawForbidden = false;

    for (const group of SUPPRESSION_GROUPS) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            if (timer.unref) timer.unref();
            let res;
            try {
                res = await fetchImpl(`${baseUrl}${group.path}?limit=500`, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                anyFailed = true;
                if (res.status === 403) sawForbidden = true;
                logger.warn('SendGrid suppression fetch returned non-OK', { group: group.type, status: res.status });
                continue;
            }
            const rows = await res.json();
            for (const r of Array.isArray(rows) ? rows : []) {
                if (!r || !r.email) continue;
                suppressions.push({
                    email: String(r.email).toLowerCase(),
                    type: group.type,
                    reason: r.reason || r.status || null,
                    // SendGrid returns `created` as a unix timestamp (seconds).
                    createdAt: r.created ? new Date(r.created * 1000).toISOString() : null,
                });
            }
        } catch (err) {
            anyFailed = true;
            logger.warn('SendGrid suppression fetch failed', { group: group.type, error: err.message });
        }
    }

    // `forbidden` is the common, actionable case: the key is valid but was
    // created without the "Suppressions: Read" scope. Distinguish it from a
    // generic partial failure so the operator knows exactly what to fix.
    const reason = anyFailed ? (sawForbidden ? 'forbidden' : 'partial') : undefined;
    return { ok: !anyFailed, ...(reason ? { reason } : {}), suppressions };
}

// Pure: splits a recipient list into those still deliverable and those that are
// suppressed (with why). Case-insensitive. Side-effect-free so it can be tested
// without any network.
function filterSuppressed(recipients, suppressions) {
    const bad = new Map();
    for (const s of suppressions || []) {
        if (s && s.email) bad.set(s.email.toLowerCase(), s);
    }
    const deliverable = [];
    const skipped = [];
    for (const r of recipients || []) {
        const hit = bad.get(String(r).toLowerCase());
        if (hit) skipped.push({ email: r, type: hit.type, reason: hit.reason });
        else deliverable.push(r);
    }
    return { deliverable, skipped };
}

module.exports = { fetchSuppressions, filterSuppressed, SUPPRESSION_GROUPS, SENDGRID_API_BASE };
