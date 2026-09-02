const crypto = require('crypto');

// Security middleware for the admin dashboard, dependency-free (no helmet etc.)
// to keep the install surface small. Three concerns live here: response
// security headers, a CSRF synchronizer token, and in-memory rate limiting
// (brute-force throttle + a bound on the unauthenticated /status probe).

// ---------------------------------------------------------------------------
// Response security headers
// ---------------------------------------------------------------------------

// The admin pages are server-rendered HTML that needs NO client-side JavaScript
// and only inline <style> — so the CSP forbids scripts entirely (script-src
// falls through to default-src 'none') while permitting inline styles. That
// closes off injected-script XSS by construction. HSTS is emitted only when the
// request actually arrived over HTTPS (req.secure respects a trusted proxy's
// X-Forwarded-Proto) — sending it on a plain-HTTP dev connection would wrongly
// pin the browser to HTTPS for a host that doesn't serve it.
function securityHeaders(req, res, next) {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    if (req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
}

// ---------------------------------------------------------------------------
// CSRF protection
// ---------------------------------------------------------------------------

// A single random token per process, embedded as a hidden field in every form
// and required on every state-changing request. It works precisely because the
// same-origin policy stops a cross-origin attacker page from reading the served
// HTML to learn the token, while a legitimate authenticated same-origin page
// receives it. This is a synchronizer token that isn't tied to a per-user
// session — acceptable here because the dashboard is a single-tenant, single-
// credential admin. A process restart rotates it (open forms then 403 → reload).
const CSRF_TOKEN = crypto.randomBytes(32).toString('hex');

function csrfToken() {
    return CSRF_TOKEN;
}

function validateCsrf(provided) {
    if (typeof provided !== 'string' || provided.length !== CSRF_TOKEN.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(CSRF_TOKEN));
    } catch {
        return false;
    }
}

// Guards mutating methods. Safe (read-only) methods pass through untouched.
// Layer 1: if an Origin header is present it must match the target host — kills
// classic cross-site form posts outright. Layer 2: the synchronizer token.
function csrfProtection(req, res, next) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const origin = req.headers.origin;
    if (origin) {
        let originHost = null;
        try { originHost = new URL(origin).host; } catch { originHost = null; }
        if (originHost && originHost !== req.headers.host) {
            return res.status(403).send('Cross-origin request blocked.');
        }
    }

    const provided = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
    if (!validateCsrf(provided)) {
        return res.status(403).send('Invalid or missing CSRF token — reload the page and try again.');
    }
    return next();
}

// Convenience: the hidden form field markup. Token is hex (no HTML-special
// chars), so it's safe to inline directly.
function csrfField() {
    return `<input type="hidden" name="_csrf" value="${CSRF_TOKEN}">`;
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, fixed window)
// ---------------------------------------------------------------------------

function clientIp(req) {
    return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
}

// Minimal fixed-window counter. `count` peeks (used to decide whether to block
// before an auth check); `increment` records a hit. Entries self-expire at the
// window boundary; sweep() bounds memory if many distinct IPs appear.
class FixedWindowCounter {
    constructor({ windowMs }) {
        this.windowMs = windowMs;
        this.hits = new Map();
    }

    _entry(key, now) {
        let e = this.hits.get(key);
        if (!e || now >= e.resetAt) {
            e = { count: 0, resetAt: now + this.windowMs };
            this.hits.set(key, e);
        }
        return e;
    }

    count(key, now = Date.now()) {
        return this._entry(key, now).count;
    }

    increment(key, now = Date.now()) {
        const e = this._entry(key, now);
        e.count += 1;
        return e.count;
    }

    resetMs(key, now = Date.now()) {
        const e = this.hits.get(key);
        return e ? Math.max(0, e.resetAt - now) : 0;
    }

    reset(key) {
        this.hits.delete(key);
    }

    sweep(now = Date.now()) {
        for (const [k, e] of this.hits) {
            if (now >= e.resetAt) this.hits.delete(k);
        }
    }
}

// Generic per-IP limiter middleware. Returns 429 + Retry-After once an IP
// exceeds `max` requests within `windowMs`.
function createRateLimiter({ windowMs, max, message = 'Too many requests — slow down and try again shortly.' }) {
    const counter = new FixedWindowCounter({ windowMs });
    const timer = setInterval(() => counter.sweep(), windowMs);
    if (timer.unref) timer.unref(); // don't keep the process alive for the sweep

    const middleware = (req, res, next) => {
        const key = clientIp(req);
        const n = counter.increment(key);
        if (n > max) {
            res.setHeader('Retry-After', Math.ceil(counter.resetMs(key) / 1000));
            return res.status(429).send(message);
        }
        return next();
    };
    middleware.counter = counter; // exposed for tests
    return middleware;
}

// ---------------------------------------------------------------------------
// Brute-force throttle for Basic Auth
// ---------------------------------------------------------------------------

const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_AUTH_FAILURES = 10; // failed logins per window per IP before lock-out
const authFailureCounter = new FixedWindowCounter({ windowMs: AUTH_WINDOW_MS });

// Placed BEFORE basicAuth: an IP over its failure budget is turned away with a
// 429 without the credentials even being checked, so repeated guessing can't
// keep probing (and can't keep burning timing-safe comparisons).
function authThrottle(req, res, next) {
    const key = clientIp(req);
    if (authFailureCounter.count(key) >= MAX_AUTH_FAILURES) {
        res.setHeader('Retry-After', Math.ceil(authFailureCounter.resetMs(key) / 1000));
        return res.status(429).send('Too many failed login attempts — try again later.');
    }
    return next();
}

function noteAuthFailure(req) {
    authFailureCounter.increment(clientIp(req));
}

function noteAuthSuccess(req) {
    authFailureCounter.reset(clientIp(req)); // a good login clears the penalty
}

module.exports = {
    securityHeaders,
    csrfToken,
    csrfField,
    csrfProtection,
    validateCsrf,
    createRateLimiter,
    authThrottle,
    noteAuthFailure,
    noteAuthSuccess,
    clientIp,
    FixedWindowCounter,
    AUTH_WINDOW_MS,
    MAX_AUTH_FAILURES,
    // exposed so a test can drive the shared auth counter deterministically
    _authFailureCounter: authFailureCounter,
};
