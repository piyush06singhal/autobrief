const sgMail = require('@sendgrid/mail');
const { sendgridApiKey, sendgridFromEmail } = require('../config/env');
const { readSettings } = require('../config/settings');
const { withRetry } = require('../utils/retry');
const { fetchSuppressions, filterSuppressed } = require('./suppressions');
const logger = require('../utils/logger');

// The .env.example placeholder. SendGrid rejects (403) any send whose `from`
// address isn't a verified sender/domain, so shipping with this default would
// fail silently-looking at send time. We warn loudly instead.
const PLACEHOLDER_FROM = 'reports@example.com';

// Retry network-level failures and 429/5xx (transient); don't retry 4xx like
// an invalid recipient or unverified sender — a second attempt won't fix those.
function isTransientSendGridError(err) {
    const status = err.code;
    return status === undefined || status === 429 || status >= 500;
}

// Decides who actually receives a send, given the saved settings and the
// configured from-address. Pure and side-effect-free so it can be unit-tested
// without SendGrid or the filesystem. Test mode redirects every send to a single
// safe inbox (the test address, or the sender itself) so a real recipient list
// is never emailed while verifying setup.
function resolveRecipients(settings, fromEmail = sendgridFromEmail) {
    if (settings.testMode) {
        const testEmail = settings.testModeEmail || fromEmail;
        return { recipients: testEmail ? [testEmail] : [], redirected: true };
    }
    const recipients = Array.isArray(settings.recipients) ? settings.recipients : [];
    return { recipients, redirected: false };
}

// Warns once per send if the sender is still the placeholder — the single most
// common reason a correctly-wired pipeline still doesn't deliver.
function warnIfPlaceholderSender() {
    if (!sendgridFromEmail || sendgridFromEmail === PLACEHOLDER_FROM) {
        logger.warn(
            `SENDGRID_FROM_EMAIL is "${sendgridFromEmail}", which is a placeholder. SendGrid will reject sends from an unverified address (403). Set it to a Verified Sender in your SendGrid account.`
        );
    }
}

// A short, clean HTML body so the email itself looks professional in the inbox,
// not just the attached PDF. Plain text is always included as a fallback.
function buildReportBody(periodLabel) {
    const text = `Your weekly business report for the week ending ${periodLabel} is attached as a PDF.\n\nThis report was generated and delivered automatically.`;
    const html = `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#12172b">
    <div style="border-bottom:3px solid #12172b;padding-bottom:10px;margin-bottom:16px">
      <div style="font-size:18px;font-weight:700">Weekly Business Report</div>
      <div style="font-size:13px;color:#6b7280">Week ending ${escapeHtml(periodLabel)}</div>
    </div>
    <p style="font-size:14px;line-height:1.5">Your weekly business report is attached as a PDF.</p>
    <p style="font-size:12px;color:#6b7280;line-height:1.5">This report was generated and delivered automatically. If you weren't expecting it, you can safely ignore this message.</p>
  </div>`;
    return { text, html };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
}

// Sends one message to one recipient with transient-error retry. Shared by the
// report send and the "send test email" verification path.
async function sendOne({ to, subject, text, html, attachments }) {
    return withRetry(
        () => sgMail.send({ to, from: sendgridFromEmail, subject, text, html, attachments }),
        { retries: 1, delayMs: 3000, label: `SendGrid send to ${to}`, shouldRetry: isTransientSendGridError }
    );
}

// Sends the PDF report to all configured recipients. If SendGrid isn't
// configured, logs a warning and skips instead of failing the whole job —
// the PDF is still archived locally either way.
async function sendReportEmail({ pdfBuffer, periodLabel, filename }) {
    if (!sendgridApiKey) {
        logger.warn('SENDGRID_API_KEY not set — skipping email send. Report was still saved to output/.');
        return { sent: false, reason: 'no_api_key' };
    }

    const settings = readSettings();
    const { recipients, redirected } = resolveRecipients(settings);

    if (redirected) {
        logger.warn(`Test mode is ON — redirecting send to ${recipients.join(', ') || '(nobody: no test address and no sender)'} instead of the real recipient list`);
    }

    if (recipients.length === 0) {
        logger.warn('No recipients configured — skipping email send. Set REPORT_RECIPIENTS in .env or manage recipients from the admin dashboard.');
        return { sent: false, reason: 'no_recipients' };
    }

    warnIfPlaceholderSender();
    sgMail.setApiKey(sendgridApiKey);

    // Bounce/complaint protection: drop recipients SendGrid already knows are
    // bad (hard bounces, spam complaints, invalid, blocked) before sending.
    // SendGrid would refuse them anyway, but knowingly re-submitting bad
    // addresses hurts sender reputation and junks mail to everyone else. This
    // is best-effort — a suppression-API failure must not stop the report — and
    // is skipped in test mode (that path deliberately targets one chosen inbox).
    let deliverable = recipients;
    let suppressed = [];
    if (!redirected) {
        const { ok, reason, suppressions } = await fetchSuppressions({ apiKey: sendgridApiKey });
        if (ok && suppressions.length) {
            const filtered = filterSuppressed(recipients, suppressions);
            deliverable = filtered.deliverable;
            suppressed = filtered.skipped;
            if (suppressed.length) {
                logger.warn(
                    `Skipping ${suppressed.length} suppressed recipient(s) (bounced/complained/invalid) — `
                    + 'SendGrid would not deliver to them and re-sending harms deliverability',
                    { skipped: suppressed },
                );
            }
        } else if (!ok) {
            // Never block the report over a suppression-read failure; just say so.
            logger.warn(
                reason === 'forbidden'
                    ? 'Suppression filtering OFF: the SendGrid key lacks the "Suppressions: Read" scope (403). '
                        + 'Sending to all configured recipients. Add the scope to enable bounce/complaint skipping.'
                    : 'Could not read SendGrid suppressions; sending to all configured recipients without bounce filtering.',
            );
        }
    }

    if (deliverable.length === 0) {
        logger.warn('Every configured recipient is on a SendGrid suppression list — nothing to send.');
        return { sent: false, reason: 'all_recipients_suppressed', suppressed };
    }

    const { text, html } = buildReportBody(periodLabel);
    const attachments = [
        { content: pdfBuffer.toString('base64'), filename, type: 'application/pdf', disposition: 'attachment' },
    ];

    const results = { sent: [], failed: [] };
    for (const recipient of deliverable) {
        try {
            await sendOne({ to: recipient, subject: `Weekly Business Report — ${periodLabel}`, text, html, attachments });
            results.sent.push(recipient);
        } catch (err) {
            const details = err.response?.body?.errors || err.message;
            logger.error(`Failed to send report to ${recipient}`, { error: details });
            results.failed.push(recipient);
        }
    }

    return { sent: true, ...results, ...(suppressed.length ? { suppressed } : {}) };
}

// Sends a tiny verification email so a self-hoster can confirm — from the admin
// dashboard — that SendGrid is wired up and mail actually reaches their inbox,
// without waiting for the weekly run. Returns a structured result the UI shows.
async function sendTestEmail({ to }) {
    const target = (to || '').trim();
    if (!target) return { ok: false, reason: 'no_recipient', message: 'Enter an email address to send the test to.' };
    if (!sendgridApiKey) return { ok: false, reason: 'no_api_key', message: 'SENDGRID_API_KEY is not set, so no email can be sent. The weekly report will still be saved to output/.' };
    if (!sendgridFromEmail || sendgridFromEmail === PLACEHOLDER_FROM) {
        return { ok: false, reason: 'placeholder_sender', message: `SENDGRID_FROM_EMAIL is "${sendgridFromEmail}", a placeholder. Set it to a Verified Sender in SendGrid, or the send will be rejected (403).` };
    }

    sgMail.setApiKey(sendgridApiKey);
    const now = new Date().toLocaleString('en-US');
    try {
        await sendOne({
            to: target,
            subject: 'Test email — Automated Weekly Report',
            text: `This is a test from your Automated Weekly Report setup, sent ${now}. If you received it, email delivery is working and the weekly report will arrive at this address.`,
            html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#12172b"><p style="font-size:14px">✅ <strong>Email delivery is working.</strong></p><p style="font-size:13px;color:#374151">This test was sent from your Automated Weekly Report setup on ${escapeHtml(now)}. Your weekly report will be delivered to the addresses you configured.</p></div>`,
        });
        return { ok: true, message: `Test email sent to ${target}. Check that inbox (and spam) to confirm delivery.` };
    } catch (err) {
        const details = err.response?.body?.errors?.map((e) => e.message).join('; ') || err.message;
        return { ok: false, reason: 'send_failed', message: `SendGrid rejected the send: ${details}` };
    }
}

module.exports = { sendReportEmail, sendTestEmail, resolveRecipients };
