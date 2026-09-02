const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertSelectOnly } = require('../src/db/safeQuery');

// assertSelectOnly is the fast static guard. The real, server-enforced
// guarantee is the READ ONLY transaction in runReadOnly() — exercised against a
// live database in the db:validate / setup flows, not here.

test('assertSelectOnly allows SELECT and WITH queries', () => {
    assert.doesNotThrow(() => assertSelectOnly('SELECT 1 AS value'));
    assert.doesNotThrow(() => assertSelectOnly('  WITH x AS (SELECT 1 AS v) SELECT * FROM x  '));
    assert.doesNotThrow(() => assertSelectOnly('SELECT 1 AS value;')); // a single trailing ; is fine
});

test('assertSelectOnly rejects non-SELECT statements', () => {
    assert.throws(() => assertSelectOnly('UPDATE users SET churned_at = now()'), /read-only/i);
    assert.throws(() => assertSelectOnly('DROP TABLE users'), /read-only/i);
    assert.throws(() => assertSelectOnly('DELETE FROM users'), /read-only/i);
    assert.throws(() => assertSelectOnly('INSERT INTO users VALUES (1)'), /read-only/i);
});

test('assertSelectOnly rejects stacked statements', () => {
    assert.throws(() => assertSelectOnly('SELECT 1; DROP TABLE users'), /single SQL statement/i);
});

test('assertSelectOnly rejects a write statement hidden behind a comment', () => {
    assert.throws(() => assertSelectOnly('-- looks harmless\nDROP TABLE users'), /read-only/i);
    assert.throws(() => assertSelectOnly('/* comment */ DELETE FROM users'), /read-only/i);
});

test('assertSelectOnly rejects empty or comment-only input', () => {
    assert.throws(() => assertSelectOnly('   '), /empty/i);
    assert.throws(() => assertSelectOnly('-- only a comment'), /empty/i);
});
