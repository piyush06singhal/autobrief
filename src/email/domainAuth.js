const dns = require('dns').promises;

// Free consumer-mail domains can NOT be domain-authenticated (you don't control
// their DNS), so mail "from" one of them sent through SendGrid can't be
// DKIM-signed on that domain and will fail DMARC alignment — the big providers
// increasingly reject or junk it. A self-hoster must send from a domain they
// own. This list is the common set; it doesn't need to be exhaustive to catch
// the mistake we care about.
const FREEMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'yahoo.co.uk',
    'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.net',
    'zoho.com', 'proton.me', 'protonmail.com', 'yandex.com', 'mail.com',
]);

// Reserved-for-documentation domains (RFC 2606) — this is the shipped
// placeholder (reports@example.com) and can never be a real verified sender.
// Reaching this means SENDGRID_FROM_EMAIL was never set to a real address.
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net']);

function domainOf(email) {
    const at = String(email || '').lastIndexOf('@');
    if (at === -1) return '';
    return email.slice(at + 1).trim().toLowerCase();
}

// dns.resolveTxt returns string[][]: one entry per record, each split into
// <=255-char chunks that must be concatenated back into the real record.
function joinTxt(chunks) {
    return Array.isArray(chunks) ? chunks.join('') : String(chunks);
}

// ---- Pure evaluators (no I/O) — what the unit tests pin down. ----

// SPF authorizes which servers may send for the domain. For SendGrid it should
// include `include:sendgrid.net`; without that, SendGrid mail can fail SPF.
function evaluateSpf(txtRecords) {
    const records = (txtRecords || []).map(joinTxt);
    const spf = records.find((r) => /^v=spf1\b/i.test(r));
    if (!spf) {
        return {
            status: 'warn', present: false,
            detail: 'No SPF record found. Add a TXT record "v=spf1 include:sendgrid.net ~all" '
                + 'so receivers know SendGrid is allowed to send for your domain.',
        };
    }
    if (!/include:sendgrid\.net/i.test(spf)) {
        return {
            status: 'warn', present: true, record: spf,
            detail: 'An SPF record exists but does not include SendGrid (include:sendgrid.net); '
                + 'SendGrid mail may fail SPF. Add the SendGrid include.',
        };
    }
    return { status: 'ok', present: true, record: spf, detail: 'SPF present and authorizes SendGrid.' };
}

// DMARC tells receivers what to do with mail that fails SPF+DKIM, and turns on
// reporting. Any published policy is a pass here; we surface which one.
function evaluateDmarc(txtRecords) {
    const records = (txtRecords || []).map(joinTxt);
    const dmarc = records.find((r) => /^v=DMARC1\b/i.test(r));
    if (!dmarc) {
        return {
            status: 'warn', present: false, policy: null,
            detail: 'No DMARC record found. Add a TXT record at _dmarc.<domain> — start with '
                + '"v=DMARC1; p=none; rua=mailto:you@domain" to monitor, then tighten to quarantine/reject.',
        };
    }
    const m = dmarc.match(/\bp=\s*([a-z]+)/i);
    const policy = m ? m[1].toLowerCase() : 'none';
    return { status: 'ok', present: true, policy, record: dmarc, detail: `DMARC present (policy p=${policy}).` };
}

// DKIM is the cryptographic signature and the strongest signal. SendGrid's
// "Domain Authentication" publishes CNAMEs like s1._domainkey.<domain>; if that
// resolves, the domain is set up to DKIM-sign SendGrid mail.
function evaluateDkim(cnameResolved) {
    if (cnameResolved) {
        return {
            status: 'ok', present: true,
            detail: 'DKIM CNAME (s1._domainkey) resolves — SendGrid Domain Authentication is in place.',
        };
    }
    return {
        status: 'warn', present: false,
        detail: 'DKIM is not set up: s1._domainkey.<domain> does not resolve. Complete '
            + 'Sender Authentication → Authenticate Your Domain in SendGrid and add the CNAMEs it gives you.',
    };
}

function worstOf(statuses) {
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('warn')) return 'warn';
    return 'ok';
}

// ---- I/O wrappers: DNS lookups, tolerant of "not configured". ----
// A missing name (ENOTFOUND) or no matching record (ENODATA) both mean the same
// thing for deliverability — "not set up" — so both collapse to an empty result
// rather than an exception.
async function resolveTxtSafe(resolver, name) {
    try { return await resolver.resolveTxt(name); } catch { return []; }
}
async function resolveCnameSafe(resolver, name) {
    try {
        const out = await resolver.resolveCname(name);
        return Array.isArray(out) ? out.length > 0 : Boolean(out);
    } catch { return false; }
}

// Checks whether the sending domain is set up to pass SPF, DKIM and DMARC.
// `resolver` is injectable (defaults to the real DNS) so the logic can be
// unit-tested without live DNS. Returns a machine-readable verdict + guidance.
async function checkDomainAuth(fromEmail, { resolver = dns } = {}) {
    const domain = domainOf(fromEmail);
    if (!domain) {
        return {
            status: 'error', domain: null, fromEmail: fromEmail || null,
            detail: 'No sending domain — SENDGRID_FROM_EMAIL is empty or not a valid address.',
        };
    }
    if (PLACEHOLDER_DOMAINS.has(domain)) {
        return {
            status: 'error', domain, placeholder: true,
            checks: {
                spf: { status: 'error', present: false, detail: 'Reserved/documentation domain — not a real sender.' },
                dkim: { status: 'error', present: false, detail: 'Reserved/documentation domain — cannot be authenticated.' },
                dmarc: { status: 'error', present: false, detail: 'Reserved/documentation domain — cannot be authenticated.' },
            },
            detail: `"${domain}" is the placeholder sending address — SENDGRID_FROM_EMAIL was never set to a real `
                + 'address. SendGrid will reject sends from an unverified sender (403). Set it to an address at a '
                + 'domain you own and have authenticated in SendGrid.',
        };
    }
    if (FREEMAIL_DOMAINS.has(domain)) {
        return {
            status: 'error', domain, freemail: true,
            checks: {
                spf: { status: 'error', present: false, detail: 'A consumer-mail domain cannot publish SPF for SendGrid.' },
                dkim: { status: 'error', present: false, detail: 'You cannot DKIM-sign a domain you do not own.' },
                dmarc: { status: 'error', present: false, detail: 'Consumer domains enforce their own strict DMARC.' },
            },
            detail: `"${domain}" is a free consumer-mail domain and cannot be authenticated. Send from a `
                + 'company domain you control, so mail can be DKIM-signed and pass DMARC — otherwise the '
                + 'big inbox providers will reject or spam-folder your reports.',
        };
    }

    const [spf, dmarc, dkim] = await Promise.all([
        resolveTxtSafe(resolver, domain).then(evaluateSpf),
        resolveTxtSafe(resolver, `_dmarc.${domain}`).then(evaluateDmarc),
        resolveCnameSafe(resolver, `s1._domainkey.${domain}`).then(evaluateDkim),
    ]);

    const checks = { spf, dkim, dmarc };
    const status = worstOf(Object.values(checks).map((c) => c.status));
    const detail = status === 'ok'
        ? `Sending domain "${domain}" is fully authenticated (SPF + DKIM + DMARC).`
        : `Sending domain "${domain}" is missing recommended authentication — see the per-record detail.`;
    return { domain, freemail: false, status, checks, detail };
}

module.exports = {
    checkDomainAuth,
    domainOf,
    // exported for unit tests
    evaluateSpf,
    evaluateDmarc,
    evaluateDkim,
    FREEMAIL_DOMAINS,
    PLACEHOLDER_DOMAINS,
};
