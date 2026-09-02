#!/usr/bin/env node
// Checks email deliverability for an unattended deployment, without sending
// anything. Two questions it answers concretely:
//   1. Is the sending domain authenticated? (SPF + DKIM + DMARC via real DNS)
//   2. Which recipients has SendGrid suppressed? (hard bounces / spam complaints
//      / invalid / blocked — the addresses that quietly stop receiving mail)
//
//   node scripts/check-email.js            # print report, exit 1 if misconfigured
//   node scripts/check-email.js --alert    # also send a Slack/email alert on error
//
// Exit codes: 0 = ok or degraded (mail can be delivered), 1 = error (the sending
// domain is unusable — a freemail from-address, or the unconfigured placeholder
// reports@example.com — so reports won't land). Domain-auth *warnings* (a missing
// DKIM/DMARC record) are surfaced but do not trip exit 1, so tightening DNS never
// blocks an otherwise-working setup.

const { checkDomainAuth } = require('../src/email/domainAuth');
const { fetchSuppressions } = require('../src/email/suppressions');
const { sendgridFromEmail, sendgridApiKey } = require('../src/config/env');
const { sendAlert } = require('../src/utils/alert');

function summarizeSuppressions(result) {
    const byType = {};
    for (const s of result.suppressions) byType[s.type] = (byType[s.type] || 0) + 1;
    let note;
    if (!sendgridApiKey) {
        note = 'SENDGRID_API_KEY not set — cannot read bounces/complaints.';
    } else if (result.reason === 'forbidden') {
        note = 'SendGrid returned 403 — your API key can send mail but lacks the "Suppressions: Read" '
            + 'scope, so bounce/complaint filtering is OFF. Add that scope to the key (or use a Full Access '
            + 'key) to enable automatic skipping of bad addresses.';
    } else if (!result.ok) {
        note = 'Some suppression groups could not be read (see logs); counts may be partial.';
    }
    return {
        checked: result.ok,
        ...(note ? { note } : {}),
        count: result.suppressions.length,
        byType,
        // A short sample only — the full list can be large and is on SendGrid.
        sample: result.suppressions.slice(0, 10),
    };
}

async function main() {
    const wantAlert = process.argv.includes('--alert');

    const sendingDomain = await checkDomainAuth(sendgridFromEmail);
    const suppressionResult = await fetchSuppressions({ apiKey: sendgridApiKey });
    const suppressions = summarizeSuppressions(suppressionResult);

    // Exit status is driven by the sending domain: an 'error' there (freemail or
    // empty from-address) means reports fundamentally won't deliver. Missing
    // DKIM/DMARC is 'warn' -> 'degraded' (still delivers, just less trusted).
    const status = sendingDomain.status === 'error' ? 'error'
        : sendingDomain.status === 'warn' ? 'degraded' : 'ok';

    const report = { checkedAt: new Date().toISOString(), status, sendingDomain, suppressions };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    if (status === 'error' && wantAlert) {
        await sendAlert({
            subject: 'Email deliverability check FAILED',
            message: `The report sending domain is unusable: ${sendingDomain.detail}`,
        });
    }

    process.exitCode = status === 'error' ? 1 : 0;
}

main().catch((err) => {
    process.stderr.write(`check-email failed: ${err.message}\n`);
    process.exitCode = 1;
});
