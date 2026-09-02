const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    checkDomainAuth, domainOf, evaluateSpf, evaluateDmarc, evaluateDkim,
} = require('../src/email/domainAuth');

// A fake DNS resolver: hand it the TXT records (as SendGrid/dns return them —
// string[][]) and whether the DKIM CNAME resolves.
function fakeResolver({ txt = {}, cname = {} } = {}) {
    return {
        async resolveTxt(name) {
            if (name in txt) return txt[name];
            const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
        },
        async resolveCname(name) {
            if (name in cname) return cname[name];
            const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
        },
    };
}

// ---- pure evaluators ----

test('domainOf extracts the lowercase domain', () => {
    assert.equal(domainOf('Reports@Acme.COM'), 'acme.com');
    assert.equal(domainOf('nope'), '');
    assert.equal(domainOf(''), '');
});

test('evaluateSpf: missing / present-without-sendgrid / good', () => {
    assert.equal(evaluateSpf([]).status, 'warn');
    assert.equal(evaluateSpf([['v=spf1 include:_spf.google.com ~all']]).status, 'warn');
    const good = evaluateSpf([['v=spf1 include:sendgrid.net ~all']]);
    assert.equal(good.status, 'ok');
    assert.equal(good.present, true);
});

test('evaluateSpf joins chunked TXT records', () => {
    // dns splits long records into <=255-char chunks; they must be rejoined.
    const good = evaluateSpf([['v=spf1 ', 'include:sendgrid.net ', '~all']]);
    assert.equal(good.status, 'ok');
});

test('evaluateDmarc: missing vs present reports policy', () => {
    assert.equal(evaluateDmarc([]).status, 'warn');
    const r = evaluateDmarc([['v=DMARC1; p=quarantine; rua=mailto:d@acme.com']]);
    assert.equal(r.status, 'ok');
    assert.equal(r.policy, 'quarantine');
});

test('evaluateDkim: resolved vs not', () => {
    assert.equal(evaluateDkim(true).status, 'ok');
    assert.equal(evaluateDkim(false).status, 'warn');
});

// ---- checkDomainAuth (integration of the evaluators over the fake resolver) ----

test('checkDomainAuth: a fully-authenticated domain is ok', async () => {
    const resolver = fakeResolver({
        txt: {
            'acme.com': [['v=spf1 include:sendgrid.net ~all']],
            '_dmarc.acme.com': [['v=DMARC1; p=reject']],
        },
        cname: { 's1._domainkey.acme.com': ['s1.domainkey.u123.wl.sendgrid.net'] },
    });
    const r = await checkDomainAuth('reports@acme.com', { resolver });
    assert.equal(r.status, 'ok');
    assert.equal(r.domain, 'acme.com');
    assert.equal(r.checks.spf.status, 'ok');
    assert.equal(r.checks.dkim.status, 'ok');
    assert.equal(r.checks.dmarc.status, 'ok');
});

test('checkDomainAuth: no DNS set up at all -> warn (not error)', async () => {
    const r = await checkDomainAuth('reports@acme.com', { resolver: fakeResolver() });
    assert.equal(r.status, 'warn');
    assert.equal(r.checks.spf.present, false);
    assert.equal(r.checks.dkim.present, false);
    assert.equal(r.checks.dmarc.present, false);
});

test('checkDomainAuth: a freemail from-address is a hard error', async () => {
    const r = await checkDomainAuth('mycompany.reports@gmail.com', { resolver: fakeResolver() });
    assert.equal(r.status, 'error');
    assert.equal(r.freemail, true);
    assert.match(r.detail, /consumer-mail domain/i);
});

test('checkDomainAuth: the shipped placeholder (example.com) is a hard error', async () => {
    // env.js defaults SENDGRID_FROM_EMAIL to reports@example.com when unset, so
    // this is exactly the "email was never configured" state. It must fail loudly
    // rather than look like an ordinary unauthenticated real domain (warn).
    const r = await checkDomainAuth('reports@example.com', { resolver: fakeResolver() });
    assert.equal(r.status, 'error');
    assert.equal(r.placeholder, true);
    assert.match(r.detail, /placeholder/i);
});

test('checkDomainAuth: empty from-address is an error', async () => {
    const r = await checkDomainAuth('', { resolver: fakeResolver() });
    assert.equal(r.status, 'error');
    assert.equal(r.domain, null);
});

test('checkDomainAuth: DKIM present but DMARC missing -> warn overall', async () => {
    const resolver = fakeResolver({
        txt: { 'acme.com': [['v=spf1 include:sendgrid.net ~all']] },
        cname: { 's1._domainkey.acme.com': ['x.sendgrid.net'] },
    });
    const r = await checkDomainAuth('reports@acme.com', { resolver });
    assert.equal(r.status, 'warn');
    assert.equal(r.checks.dkim.status, 'ok');
    assert.equal(r.checks.dmarc.status, 'warn');
});
