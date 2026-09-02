const crypto = require('crypto');
const { adminUsername, adminPassword } = require('../config/env');

function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    // timingSafeEqual throws on length mismatch, so pad to equal length first —
    // otherwise a length check alone would leak the correct length via timing.
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // burn constant time on a mismatch too
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// Protects the whole admin dashboard (report data, PDF downloads, ad-hoc
// triggers) with HTTP Basic Auth. If username/password aren't configured,
// the dashboard runs open — logged loudly at startup so it's not a silent
// gap — since forcing credentials to exist would break every existing
// deployment the moment this shipped.
//
// Factory so tests can supply fixed credentials instead of reading env vars.
// Optional { onSuccess, onFailure } hooks let the server wire in the
// brute-force throttle (clear an IP's penalty on success, count it on failure)
// without this module depending on the rate limiter. On success the
// authenticated username is stashed on req.adminUser for the audit log.
function createBasicAuth(username = adminUsername, password = adminPassword, { onSuccess, onFailure } = {}) {
    return function basicAuth(req, res, next) {
        if (!username || !password) return next();

        const header = req.headers.authorization || '';
        const [scheme, encoded] = header.split(' ');

        if (scheme === 'Basic' && encoded) {
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            const separatorIndex = decoded.indexOf(':');
            const user = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
            const pass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

            if (timingSafeStringEqual(user, username) && timingSafeStringEqual(pass, password)) {
                req.adminUser = user;
                if (onSuccess) onSuccess(req);
                return next();
            }
        }

        if (onFailure) onFailure(req);
        res.set('WWW-Authenticate', 'Basic realm="Weekly Report Admin"');
        return res.status(401).send('Authentication required');
    };
}

module.exports = { basicAuth: createBasicAuth(), createBasicAuth };
