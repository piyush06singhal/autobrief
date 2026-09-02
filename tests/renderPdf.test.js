const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPdfFromHtml, closeBrowserSafely, LAUNCH_ARGS } = require('../src/render/renderPdf');

// %PDF magic bytes — a real PDF starts with these.
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function fakePage(hooks = {}) {
    return {
        setContentArgs: null,
        async setContent(html, opts) { this.setContentArgs = { html, opts }; if (hooks.onSetContent) return hooks.onSetContent(); },
        async waitForFunction() { if (hooks.onWaitFor) return hooks.onWaitFor(); },
        async pdf() { if (hooks.onPdf) return hooks.onPdf(); return PDF_MAGIC; },
    };
}

function fakeBrowser(page, hooks = {}) {
    const b = {
        closed: 0,
        killedWith: null,
        async newPage() { if (hooks.onNewPage) return hooks.onNewPage(); return page; },
        async close() { b.closed++; if (hooks.onClose) return hooks.onClose(); },
        process() { return { kill: (sig) => { b.killedWith = sig; } }; },
    };
    return b;
}

function fakeLauncher(browser, hooks = {}) {
    return {
        lastLaunchOpts: null,
        async launch(opts) { this.lastLaunchOpts = opts; if (hooks.onLaunch) return hooks.onLaunch(); return browser; },
    };
}

// ---- happy path ----

test('renderPdf: returns a real Buffer starting with the %PDF magic bytes', async () => {
    const browser = fakeBrowser(fakePage());
    const launcher = fakeLauncher(browser);
    const out = await renderPdfFromHtml('<h1>hi</h1>', { launcher, timeoutMs: 1234 });
    assert.ok(Buffer.isBuffer(out), 'returns a Node Buffer, not a Uint8Array');
    assert.equal(out.subarray(0, 4).toString('latin1'), '%PDF');
    assert.equal(browser.closed, 1, 'browser is closed exactly once');
});

test('renderPdf: passes the launch flags and the timeout through', async () => {
    const browser = fakeBrowser(fakePage());
    const launcher = fakeLauncher(browser);
    const page = await browser.newPage();
    // re-run through render so setContent is actually called on our page
    const b2 = fakeBrowser(page);
    const l2 = fakeLauncher(b2);
    await renderPdfFromHtml('<h1>hi</h1>', { launcher: l2, timeoutMs: 4242 });
    assert.equal(l2.lastLaunchOpts.headless, true);
    assert.equal(l2.lastLaunchOpts.protocolTimeout, 4242, 'protocolTimeout caps every CDP call');
    assert.ok(l2.lastLaunchOpts.args.includes('--no-sandbox'));
    assert.ok(l2.lastLaunchOpts.args.includes('--disable-dev-shm-usage'), 'the critical low-memory flag');
    assert.equal(page.setContentArgs.opts.timeout, 4242, 'setContent is bounded too');
});

test('LAUNCH_ARGS carries the container-critical flags', () => {
    assert.ok(LAUNCH_ARGS.includes('--no-sandbox'));
    assert.ok(LAUNCH_ARGS.includes('--disable-setuid-sandbox'));
    assert.ok(LAUNCH_ARGS.includes('--disable-dev-shm-usage'));
});

test('renderPdf: honors PUPPETEER_EXECUTABLE_PATH when set, undefined when not', async () => {
    const prev = process.env.PUPPETEER_EXECUTABLE_PATH;
    try {
        // configured (as the Docker image does → distro Chromium)
        process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium';
        const l1 = fakeLauncher(fakeBrowser(fakePage()));
        await renderPdfFromHtml('<h1>hi</h1>', { launcher: l1 });
        assert.equal(l1.lastLaunchOpts.executablePath, '/usr/bin/chromium');

        // unset (a normal host → Puppeteer's own bundled Chromium)
        delete process.env.PUPPETEER_EXECUTABLE_PATH;
        const l2 = fakeLauncher(fakeBrowser(fakePage()));
        await renderPdfFromHtml('<h1>hi</h1>', { launcher: l2 });
        assert.equal(l2.lastLaunchOpts.executablePath, undefined);
    } finally {
        if (prev === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
        else process.env.PUPPETEER_EXECUTABLE_PATH = prev;
    }
});

// ---- failure paths ----

test('renderPdf: a launch failure throws an actionable, wrapped error', async () => {
    const launcher = fakeLauncher(null, { onLaunch: () => { throw new Error('spawn ENOENT'); } });
    await assert.rejects(
        () => renderPdfFromHtml('<h1>hi</h1>', { launcher }),
        (err) => {
            assert.match(err.message, /failed to launch/i);
            assert.match(err.message, /memory/i); // points at the usual cause
            assert.match(err.message, /spawn ENOENT/); // keeps the underlying detail
            return true;
        },
    );
});

test('renderPdf: a crash mid-render still closes the browser (no process leak)', async () => {
    const browser = fakeBrowser(fakePage({ onPdf: () => { throw new Error('Target closed'); } }));
    const launcher = fakeLauncher(browser);
    await assert.rejects(() => renderPdfFromHtml('<h1>hi</h1>', { launcher }), /Target closed/);
    assert.equal(browser.closed, 1, 'finally-block cleanup ran despite the crash');
});

// ---- closeBrowserSafely ----

test('closeBrowserSafely: a close() that throws leads to a SIGKILL', async () => {
    const browser = fakeBrowser(fakePage(), { onClose: () => { throw new Error('already crashed'); } });
    await closeBrowserSafely(browser);
    assert.equal(browser.killedWith, 'SIGKILL');
});

test('closeBrowserSafely: a hanging close() is bounded and then killed', async () => {
    // close() never resolves — the timeout must fire and fall back to a kill.
    const browser = fakeBrowser(fakePage(), { onClose: () => new Promise(() => {}) });
    await closeBrowserSafely(browser, 20); // tiny timeout so the test is fast
    assert.equal(browser.killedWith, 'SIGKILL');
});

test('closeBrowserSafely: a null browser is a no-op', async () => {
    await closeBrowserSafely(null); // must not throw
});
