const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchSuppressions, filterSuppressed } = require('../src/email/suppressions');

// A fake fetch that maps a URL substring -> a response. Lets us drive the
// four suppression endpoints (and their failures) without hitting SendGrid.
function fakeFetch(routes) {
    return async (url) => {
        for (const [needle, resp] of Object.entries(routes)) {
            if (url.includes(needle)) {
                if (resp.throw) throw new Error(resp.throw);
                return {
                    ok: resp.ok !== false,
                    status: resp.status || 200,
                    json: async () => resp.body || [],
                };
            }
        }
        return { ok: true, status: 200, json: async () => [] };
    };
}

// ---- filterSuppressed (pure) ----

test('filterSuppressed splits deliverable vs suppressed, case-insensitively', () => {
    const suppressions = [
        { email: 'bounced@acme.com', type: 'bounce', reason: '550 no such user' },
        { email: 'complained@acme.com', type: 'spam_report', reason: null },
    ];
    const { deliverable, skipped } = filterSuppressed(
        ['ok@acme.com', 'BOUNCED@acme.com', 'complained@acme.com'],
        suppressions,
    );
    assert.deepEqual(deliverable, ['ok@acme.com']);
    assert.equal(skipped.length, 2);
    assert.equal(skipped[0].type, 'bounce');
    assert.equal(skipped[1].type, 'spam_report');
});

test('filterSuppressed with no suppressions passes everyone through', () => {
    const { deliverable, skipped } = filterSuppressed(['a@x.com', 'b@x.com'], []);
    assert.deepEqual(deliverable, ['a@x.com', 'b@x.com']);
    assert.equal(skipped.length, 0);
});

// ---- fetchSuppressions ----

test('fetchSuppressions returns no_api_key without throwing', async () => {
    const r = await fetchSuppressions({ apiKey: null });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_api_key');
    assert.deepEqual(r.suppressions, []);
});

test('fetchSuppressions normalizes rows across all four groups', async () => {
    const fetchImpl = fakeFetch({
        '/bounces': { body: [{ email: 'b@x.com', reason: '550', created: 1700000000 }] },
        '/spam_reports': { body: [{ email: 'c@x.com', created: 1700000001 }] },
        '/blocks': { body: [{ email: 'd@x.com', status: '4.0.0' }] },
        '/invalid_emails': { body: [{ email: 'e@x.com', reason: 'bad' }] },
    });
    const r = await fetchSuppressions({ apiKey: 'SG.test', fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.suppressions.length, 4);
    const byType = Object.fromEntries(r.suppressions.map((s) => [s.type, s]));
    assert.equal(byType.bounce.email, 'b@x.com');
    assert.equal(byType.bounce.reason, '550');
    assert.match(byType.bounce.createdAt, /^20\d\d-/); // unix->ISO
    assert.equal(byType.block.reason, '4.0.0'); // falls back to status
    assert.equal(byType.invalid_email.email, 'e@x.com');
});

test('fetchSuppressions is best-effort: a failing group marks ok=false but still returns others', async () => {
    const fetchImpl = fakeFetch({
        '/bounces': { body: [{ email: 'b@x.com' }] },
        '/spam_reports': { throw: 'network down' },
        '/blocks': { ok: false, status: 500 },
        '/invalid_emails': { body: [] },
    });
    const r = await fetchSuppressions({ apiKey: 'SG.test', fetchImpl });
    assert.equal(r.ok, false); // something failed
    assert.equal(r.reason, 'partial');
    assert.equal(r.suppressions.length, 1); // but the good group still came back
    assert.equal(r.suppressions[0].email, 'b@x.com');
});

test('fetchSuppressions reports reason=forbidden on 403 (key lacks Suppressions Read scope)', async () => {
    // This is the real behavior observed against a live Mail-Send-only key.
    const fetchImpl = fakeFetch({
        '/bounces': { ok: false, status: 403 },
        '/spam_reports': { ok: false, status: 403 },
        '/blocks': { ok: false, status: 403 },
        '/invalid_emails': { ok: false, status: 403 },
    });
    const r = await fetchSuppressions({ apiKey: 'SG.sendonly', fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'forbidden');
    assert.equal(r.suppressions.length, 0);
});
