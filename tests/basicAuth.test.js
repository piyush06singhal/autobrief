const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBasicAuth } = require('../src/admin/basicAuth');

function mockReqRes(authHeader) {
    const req = { headers: authHeader ? { authorization: authHeader } : {} };
    const res = {
        statusCode: null,
        headers: {},
        body: null,
        set(name, value) { this.headers[name] = value; return this; },
        status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; return this; },
    };
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    return { req, res, next, wasNextCalled: () => nextCalled };
}

function basicHeader(user, pass) {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

test('basicAuth calls next() when no credentials are configured (open mode)', () => {
    const auth = createBasicAuth(null, null);
    const { req, res, next, wasNextCalled } = mockReqRes();
    auth(req, res, next);
    assert.equal(wasNextCalled(), true);
});

test('basicAuth rejects requests with no Authorization header', () => {
    const auth = createBasicAuth('admin', 'secret');
    const { req, res, next, wasNextCalled } = mockReqRes();
    auth(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(res.statusCode, 401);
});

test('basicAuth rejects wrong credentials', () => {
    const auth = createBasicAuth('admin', 'secret');
    const { req, res, next, wasNextCalled } = mockReqRes(basicHeader('admin', 'wrong'));
    auth(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(res.statusCode, 401);
});

test('basicAuth accepts correct credentials', () => {
    const auth = createBasicAuth('admin', 'secret');
    const { req, res, next, wasNextCalled } = mockReqRes(basicHeader('admin', 'secret'));
    auth(req, res, next);
    assert.equal(wasNextCalled(), true);
    assert.equal(res.statusCode, null, 'should not have set an error status');
});

test('basicAuth rejects a password that is a differing length from the correct one', () => {
    const auth = createBasicAuth('admin', 'secret');
    const { req, res, next, wasNextCalled } = mockReqRes(basicHeader('admin', 'x'));
    auth(req, res, next);
    assert.equal(wasNextCalled(), false);
    assert.equal(res.statusCode, 401);
});
