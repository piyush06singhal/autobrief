const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    securityHeaders,
    csrfToken,
    csrfField,
    csrfProtection,
    validateCsrf,
    createRateLimiter,
    authThrottle,
    noteAuthFailure,
    noteAuthSuccess,
    FixedWindowCounter,
    MAX_AUTH_FAILURES,
} = require('../src/admin/security');
const { createBasicAuth } = require('../src/admin/basicAuth');

// ---- tiny mock req/res (same spirit as basicAuth.test.js) ----

function mockRes() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        set(k, v) { this.headers[String(k).toLowerCase()] = v; },
        send(b) { this.body = b; return this; },
        json(b) { this.body = b; return this; },
    };
}

function mockReq({ method = 'GET', headers = {}, body = {}, ip = '10.0.0.1', secure = false } = {}) {
    return { method, headers, body, ip, socket: { remoteAddress: ip }, secure };
}

function run(mw, req) {
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

// ---- fixed-window counter (the primitive under the limiters) ----

test('FixedWindowCounter: count peeks, increment records', () => {
    const c = new FixedWindowCounter({ windowMs: 1000 });
    const t0 = 1_000_000;
    assert.equal(c.count('k', t0), 0); // peek doesn't create a hit
    assert.equal(c.increment('k', t0), 1);
    assert.equal(c.increment('k', t0), 2);
    assert.equal(c.count('k', t0), 2); // still 2 — peek didn't add
});

test('FixedWindowCounter: the window resets after it elapses', () => {
    const c = new FixedWindowCounter({ windowMs: 1000 });
    const t0 = 1_000_000;
    c.increment('k', t0);
    c.increment('k', t0);
    assert.equal(c.count('k', t0 + 999), 2); // still inside the window
    assert.equal(c.count('k', t0 + 1000), 0); // window rolled over
});

test('FixedWindowCounter: reset clears a key immediately', () => {
    const c = new FixedWindowCounter({ windowMs: 1000 });
    c.increment('k', 0);
    c.reset('k');
    assert.equal(c.count('k', 0), 0);
});

// ---- generic rate limiter middleware ----

test('rate limiter: allows up to max, then 429 with Retry-After', () => {
    const mw = createRateLimiter({ windowMs: 60_000, max: 3 });
    const ip = '1.2.3.4';
    for (let i = 0; i < 3; i++) {
        const { res, nextCalled } = run(mw, mockReq({ ip }));
        assert.equal(nextCalled, true, `request ${i + 1} should pass`);
        assert.equal(res.statusCode, 200);
    }
    const { res, nextCalled } = run(mw, mockReq({ ip }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['retry-after'], 'sets Retry-After');
});

test('rate limiter: separate IPs have independent budgets', () => {
    const mw = createRateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(run(mw, mockReq({ ip: 'a' })).nextCalled, true);
    assert.equal(run(mw, mockReq({ ip: 'a' })).nextCalled, false); // 'a' exhausted
    assert.equal(run(mw, mockReq({ ip: 'b' })).nextCalled, true); // 'b' unaffected
});

// ---- CSRF ----

test('validateCsrf: accepts the real token, rejects everything else', () => {
    assert.equal(validateCsrf(csrfToken()), true);
    assert.equal(validateCsrf('nope'), false);
    assert.equal(validateCsrf(''), false);
    assert.equal(validateCsrf(undefined), false);
    assert.equal(validateCsrf(csrfToken() + 'x'), false); // wrong length
});

test('csrfField: embeds the current token as a hidden input', () => {
    assert.ok(csrfField().includes(csrfToken()));
    assert.ok(csrfField().includes('name="_csrf"'));
});

test('csrf: safe methods pass without a token', () => {
    assert.equal(run(csrfProtection, mockReq({ method: 'GET' })).nextCalled, true);
    assert.equal(run(csrfProtection, mockReq({ method: 'HEAD' })).nextCalled, true);
});

test('csrf: a POST without a token is rejected 403', () => {
    const { res, nextCalled } = run(csrfProtection, mockReq({ method: 'POST', body: {} }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
});

test('csrf: a POST with the valid token in the body passes', () => {
    const { nextCalled } = run(csrfProtection, mockReq({ method: 'POST', body: { _csrf: csrfToken() } }));
    assert.equal(nextCalled, true);
});

test('csrf: a POST with the valid token in the x-csrf-token header passes', () => {
    const { nextCalled } = run(csrfProtection, mockReq({ method: 'POST', headers: { 'x-csrf-token': csrfToken() } }));
    assert.equal(nextCalled, true);
});

test('csrf: a cross-origin POST is blocked even with a valid token', () => {
    const { res, nextCalled } = run(csrfProtection, mockReq({
        method: 'POST',
        headers: { origin: 'https://evil.example', host: 'localhost:4000' },
        body: { _csrf: csrfToken() },
    }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
});

test('csrf: a same-origin POST with a valid token passes', () => {
    const { nextCalled } = run(csrfProtection, mockReq({
        method: 'POST',
        headers: { origin: 'http://localhost:4000', host: 'localhost:4000' },
        body: { _csrf: csrfToken() },
    }));
    assert.equal(nextCalled, true);
});

// ---- security headers ----

test('securityHeaders: sets CSP and the anti-clickjacking / sniffing headers', () => {
    const { res, nextCalled } = run(securityHeaders, mockReq());
    assert.equal(nextCalled, true);
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('securityHeaders: HSTS only on HTTPS requests', () => {
    assert.equal(run(securityHeaders, mockReq({ secure: false })).res.headers['strict-transport-security'], undefined);
    assert.match(run(securityHeaders, mockReq({ secure: true })).res.headers['strict-transport-security'], /max-age=/);
});

// ---- brute-force throttle for Basic Auth ----

test('authThrottle: under the failure budget the request passes', () => {
    const ip = '198.51.100.1'; // unique IP so the shared counter is isolated
    for (let i = 0; i < MAX_AUTH_FAILURES - 1; i++) noteAuthFailure(mockReq({ ip }));
    assert.equal(run(authThrottle, mockReq({ ip })).nextCalled, true);
});

test('authThrottle: at the failure budget the IP is locked out with 429', () => {
    const ip = '198.51.100.2';
    for (let i = 0; i < MAX_AUTH_FAILURES; i++) noteAuthFailure(mockReq({ ip }));
    const { res, nextCalled } = run(authThrottle, mockReq({ ip }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 429);
    assert.ok(res.headers['retry-after']);
});

test('authThrottle: a successful login clears the penalty', () => {
    const ip = '198.51.100.3';
    for (let i = 0; i < MAX_AUTH_FAILURES; i++) noteAuthFailure(mockReq({ ip }));
    noteAuthSuccess(mockReq({ ip }));
    assert.equal(run(authThrottle, mockReq({ ip })).nextCalled, true);
});

// ---- basicAuth hooks + req.adminUser (the audit-log wiring) ----

function basicHeader(user, pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

test('basicAuth: correct creds set req.adminUser and fire onSuccess', () => {
    let successReq = null;
    let failCalled = false;
    const mw = createBasicAuth('admin', 'secret', {
        onSuccess: (req) => { successReq = req; },
        onFailure: () => { failCalled = true; },
    });
    const req = mockReq({ headers: { authorization: basicHeader('admin', 'secret') } });
    const { nextCalled } = run(mw, req);
    assert.equal(nextCalled, true);
    assert.equal(req.adminUser, 'admin');
    assert.equal(successReq, req);
    assert.equal(failCalled, false);
});

test('basicAuth: wrong creds fire onFailure and do not set req.adminUser', () => {
    let successCalled = false;
    let failReq = null;
    const mw = createBasicAuth('admin', 'secret', {
        onSuccess: () => { successCalled = true; },
        onFailure: (req) => { failReq = req; },
    });
    const req = mockReq({ headers: { authorization: basicHeader('admin', 'wrong') } });
    const { res, nextCalled } = run(mw, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(req.adminUser, undefined);
    assert.ok(failReq);
    assert.equal(successCalled, false);
});
