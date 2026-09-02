const sgMail = require('@sendgrid/mail');
const {
    sendgridApiKey, sendgridFromEmail, reportRecipients, slackWebhookUrl, alertEmail,
} = require('../config/env');
const logger = require('./logger');

// Sends an operational alert over whatever channels are configured (Slack and/or
// email). Returns true if at least one channel accepted it. This is the shared
// primitive behind both a failed report run and a failed health check, so an
// unattended deployment has exactly one place that decides where alerts go.
async function sendAlert({ subject, message }) {
    let alerted = false;

    if (slackWebhookUrl) {
        try {
            const response = await fetch(slackWebhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: `:rotating_light: ${message}` }),
            });
            if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
            alerted = true;
            logger.info('Sent Slack alert');
        } catch (err) {
            logger.error('Failed to send Slack alert', { error: err.message });
        }
    }

    const recipients = alertEmail ? [alertEmail] : reportRecipients;
    if (sendgridApiKey && recipients.length > 0) {
        sgMail.setApiKey(sendgridApiKey);
        for (const recipient of recipients) {
            try {
                await sgMail.send({
                    to: recipient,
                    from: sendgridFromEmail,
                    subject,
                    text: message,
                });
                alerted = true;
                logger.info(`Sent alert email to ${recipient}`);
            } catch (err) {
                logger.error(`Failed to send alert email to ${recipient}`, {
                    error: err.response?.body?.errors || err.message,
                });
            }
        }
    }

    if (!alerted) {
        logger.warn('No alert channel configured or all alert sends failed — set SLACK_WEBHOOK_URL and/or ALERT_EMAIL to get notified.');
    }
    return alerted;
}

// Notifies someone that the scheduled report job failed to run, since a
// silent failure in an unattended weekly job just means nobody gets a
// report and nobody notices until someone asks where it is.
async function sendFailureAlert({ error, asOf }) {
    return sendAlert({
        subject: 'Weekly Report FAILED to generate',
        message: `Weekly report job failed for the week ending ${asOf}: ${error}`,
    });
}

module.exports = { sendAlert, sendFailureAlert };
