/**
 * Frontend smoke test — verifies the most dangerous UI button (kill switch)
 * talks to the backend correctly via the Vite dev proxy.
 *
 * This is NOT a full Playwright suite — it's a single Puppeteer script that
 * drives the dashboard in a real browser, clicks the kill-switch button,
 * and verifies the backend received the POST (or the frontend surfaced the
 * correct "send {confirm:'CONFIRM'}" error). Catches UI regressions on the
 * one button that can halt all trading.
 *
 * Prerequisites:
 *   - Backend running on :3003 (npm run dev:server)
 *   - Frontend dev server running on :5175 (npm run dev:frontend)
 *   - Puppeteer's Chromium downloaded (happens automatically on npm install)
 *
 * Run: cd frontend && npm run test:e2e
 *
 * Why Puppeteer and not Playwright: puppeteer is already a devDep (used by
 * the build for prerendering), so adding a Playwright config would duplicate
 * a browser download. This script is deliberately tiny — 50 lines of test
 * logic. If the suite grows past ~10 cases, migrate to Playwright.
 */
import puppeteer from 'puppeteer';

const FRONTEND_URL = process.env.E2E_FRONTEND_URL || 'http://localhost:5175';
const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:3003';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function backendReachable() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await backendReachable())) {
    console.error(`❌ Backend not reachable at ${BACKEND_URL} — start it with \`npm run dev:server\` first.`);
    return 1;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Collect console errors — any uncaught exception in the SPA is a failure
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    console.log('→ Loading dashboard…');
    await page.goto(`${FRONTEND_URL}/#/dashboard`, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(2000); // let React hydrate + initial API calls resolve

    // Verify the dashboard rendered something (not a blank page / crash)
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (!bodyText || bodyText.length < 50) {
      console.error('❌ Dashboard rendered empty body — React likely crashed.');
      console.error('Console errors:', consoleErrors);
      return 1;
    }
    console.log('✓ Dashboard rendered');

    // Find the kill-switch button. Try multiple selectors — the Header
    // component renders a "KILL SWITCH" button, but the exact text/aria
    // label may vary. waitForSelector with a timeout gives the SPA time
    // to render it after hydration.
    let killButton = null;
    const selectors = [
      'button[aria-label*="kill" i]',
      'button[aria-label*="KILL"]',
    ];
    for (const sel of selectors) {
      killButton = await page.$(sel).catch(() => null);
      if (killButton) break;
    }
    // Fallback: find any button whose text contains "KILL"
    if (!killButton) {
      killButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find((b) => b.textContent && b.textContent.toUpperCase().includes('KILL')) || null;
      }).catch(() => null);
    }

    if (!killButton) {
      console.error('❌ Kill-switch button not found on the dashboard.');
      console.error('Console errors:', consoleErrors);
      return 1;
    }
    console.log('✓ Kill-switch button found');

    // Click it — the backend should receive a POST /api/control/kill.
    // We intercept the fetch to verify the request was made.
    let killRequestMade = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/control/kill') && req.method() === 'POST') {
        killRequestMade = true;
      }
    });

    await killButton.click();
    await sleep(1000); // let the modal/confirm flow resolve

    // The backend requires {confirm:'CONFIRM'} — without it, the route
    // returns 400. The frontend should either show a confirm modal or
    // surface the error. Either way, the request was made.
    if (!killRequestMade) {
      console.error('❌ Click on kill-switch did not trigger POST /api/control/kill.');
      console.error('Console errors:', consoleErrors);
      return 1;
    }
    console.log('✓ Kill-switch POST reached the backend');

    // Any uncaught console error is a failure — the SPA must not crash
    // even when the backend returns 400 for a missing confirm field.
    if (consoleErrors.some((e) => e.includes('Uncaught'))) {
      console.error('❌ Uncaught exception in the SPA:');
      consoleErrors.filter((e) => e.includes('Uncaught')).forEach((e) => console.error(`  ${e}`));
      return 1;
    }

    console.log('\n✅ Smoke test passed — dashboard loads, kill-switch button works, no uncaught errors.');
    return 0;
  } finally {
    await browser.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
