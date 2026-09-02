const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const { pdfRenderTimeoutMs } = require('../config/env');

// Chrome launch flags tuned for unattended container use:
//   --no-sandbox / --disable-setuid-sandbox: required to run as root in a
//     container (the common self-hosted deployment).
//   --disable-dev-shm-usage: Chrome's default /dev/shm is only 64MB in Docker;
//     a large report can exhaust it and crash the tab. Routes shared memory to
//     /tmp instead — the single most important flag for memory-constrained hosts.
//   --disable-gpu: no GPU in a headless container; skip initialising it.
const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
];

// How long browser.close() may take before we stop waiting and hard-kill the
// process. A Chrome that was OOM-killed or wedged can hang on close forever.
const CLOSE_TIMEOUT_MS = 5000;

// Closes the browser without ever hanging or masking the real error. If close()
// stalls or throws (common when Chrome already crashed), the OS process is
// killed directly — leaking Chrome processes across weekly runs would slowly
// exhaust host memory and eventually break every future render.
async function closeBrowserSafely(browser, closeTimeoutMs = CLOSE_TIMEOUT_MS) {
    if (!browser) return;
    try {
        await Promise.race([
            browser.close(),
            new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error(`close() exceeded ${closeTimeoutMs}ms`)), closeTimeoutMs);
                if (t.unref) t.unref();
            }),
        ]);
    } catch (err) {
        logger.warn('Headless Chrome did not close cleanly; killing the process', { error: err.message });
        try {
            const proc = typeof browser.process === 'function' ? browser.process() : null;
            if (proc) proc.kill('SIGKILL');
        } catch {
            /* nothing more we can do — the process is likely already gone */
        }
    }
}

// Renders an HTML string to a PDF Buffer via headless Chrome.
// Waits for the report's own `window.__chartsReady` flag so the Chart.js canvas
// has actually painted before printing.
//
// Hardened for unattended use: every DevTools call is bounded by a protocol
// timeout (a wedged/OOM-killed Chrome fails instead of hanging the job), launch
// failures carry an actionable message, and the browser process is always
// cleaned up — killed if it won't close. `launcher` is injectable so the
// failure paths can be unit-tested without spawning real Chrome.
async function renderPdfFromHtml(html, { launcher = puppeteer, timeoutMs = pdfRenderTimeoutMs } = {}) {
    let browser;
    try {
        browser = await launcher.launch({
            headless: true,
            args: LAUNCH_ARGS,
            // Use a specific Chrome binary when one is configured. The Docker
            // image points this at the distro's Chromium (which runs natively
            // on both amd64 and arm64 — Puppeteer's bundled build has no
            // arm64-Linux binary). Unset on a normal host, so it stays
            // undefined and Puppeteer uses its own downloaded Chromium.
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            // Caps every DevTools-protocol call. Without it, a Chrome that dies
            // mid-command (e.g. OOM-killed in a tight container) leaves the
            // await pending indefinitely and the weekly job never completes.
            protocolTimeout: timeoutMs,
        });
    } catch (err) {
        // Launch failure is almost always a missing Chrome binary or too little
        // container memory — surface that, not a raw spawn error.
        throw new Error(
            `Headless Chrome failed to launch (${err.message}). Ensure Chromium is installed and the `
            + 'container has enough memory (Puppeteer needs a few hundred MB free).',
        );
    }

    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: timeoutMs });

        // Wait for the chart to paint, but don't let a slow/absent chart abort
        // the whole report — the stat cards and data table are still valuable.
        try {
            await page.waitForFunction('window.__chartsReady === true', { timeout: 15000 });
        } catch {
            logger.warn('Chart did not signal ready within 15s; printing report without waiting further');
        }

        const pdfBytes = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
        });

        // page.pdf() returns a Uint8Array in this Puppeteer version, not a Node
        // Buffer. Uint8Array.toString('base64') silently ignores the encoding
        // arg and comma-joins raw byte values instead — corrupting anything
        // (like the SendGrid attachment) that relies on real base64 output.
        return Buffer.from(pdfBytes);
    } finally {
        await closeBrowserSafely(browser);
    }
}

module.exports = { renderPdfFromHtml, closeBrowserSafely, LAUNCH_ARGS };
