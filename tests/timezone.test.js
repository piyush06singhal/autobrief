const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidTimezone, resolveTimezone } = require('../src/utils/timezone');

test('isValidTimezone accepts real IANA zones', () => {
    assert.equal(isValidTimezone('UTC'), true);
    assert.equal(isValidTimezone('America/New_York'), true);
    assert.equal(isValidTimezone('Europe/London'), true);
    assert.equal(isValidTimezone('Asia/Kolkata'), true);
});

test('isValidTimezone rejects junk, empty, and non-strings', () => {
    assert.equal(isValidTimezone('Not/AZone'), false);
    assert.equal(isValidTimezone(''), false);
    assert.equal(isValidTimezone('   '), false);
    assert.equal(isValidTimezone(null), false);
    assert.equal(isValidTimezone(123), false);
});

test('resolveTimezone returns an explicitly-configured valid zone', () => {
    assert.equal(
        resolveTimezone({ requested: 'America/New_York', systemTz: 'UTC' }),
        'America/New_York'
    );
});

test('resolveTimezone throws on an explicitly-configured INVALID zone (fail fast)', () => {
    assert.throws(
        () => resolveTimezone({ requested: 'Mars/Phobos', systemTz: 'UTC' }),
        /REPORT_TIMEZONE.*not a valid IANA time zone/
    );
});

test('resolveTimezone falls back to the system zone when nothing is requested', () => {
    assert.equal(resolveTimezone({ systemTz: 'Europe/Paris' }), 'Europe/Paris');
});

test('resolveTimezone falls back to UTC when system zone is unusable or absent', () => {
    assert.equal(resolveTimezone({ systemTz: 'Bogus/Zone' }), 'UTC');
    assert.equal(resolveTimezone({}), 'UTC');
    assert.equal(resolveTimezone({ fallback: 'UTC' }), 'UTC');
});

// The behavior the "week ending" / "generated at" labels depend on: the same
// instant renders as a different calendar day depending on the zone, so a report
// generated just after UTC midnight must not show tomorrow's date to a US user.
test('a fixed instant labels to the correct local day per zone', () => {
    const instant = new Date('2026-09-03T02:00:00Z'); // 10pm Sep 2 in New York
    const opts = { year: 'numeric', month: 'long', day: 'numeric' };
    assert.equal(instant.toLocaleDateString('en-US', { ...opts, timeZone: 'America/New_York' }), 'September 2, 2026');
    assert.equal(instant.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' }), 'September 3, 2026');
});
