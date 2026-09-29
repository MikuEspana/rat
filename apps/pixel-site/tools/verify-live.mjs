// The published site against the production API, in a real browser (the pages workflow's verify job).
//   SITE_URL=https://wallstreetrats.world/ SITE_API_BASE=https://....up.railway.app node apps/pixel-site/tools/verify-live.mjs
// 1. waits until the published bundle is the one built against SITE_API_BASE (Pages can take a few minutes)
// 2. the API answers /api/state and allows the site's origin (CORS)
// 3. in Chromium, desktop and phone: no console errors, no simulator, the banner the API's mode calls for (DRY RUN /
//    PAUSED / none), RATS HIRED equals the API's rat count, and "pre-launch" while there is no coin yet
// Exit code 1 on any failure. Reads only public data.
const SITE = (process.env.SITE_URL ?? 'https://wallstreetrats.world/').replace(/\/?$/, '/');
const API = (process.env.SITE_API_BASE ?? '').replace(/\/$/, '');
if (!API) {
  console.error('SITE_API_BASE is not set');
  process.exit(1);
}
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const fails = [];
const ok = (m) => console.log(`  ok    ${m}`);
const fail = (m) => {
  console.log(`  FAIL  ${m}`);
  fails.push(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. the published bundle is the production build
let live = false;
const tries = Number(process.env.VERIFY_TRIES ?? 40); // 15 s apart
for (let i = 0; i < tries && !live; i++) {
  try {
    const html = await (await fetch(`${SITE}?nocache=${Date.now()}`, { cache: 'no-store' })).text();
    for (const src of [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => new URL(m[1], SITE).href)) {
      if ((await (await fetch(src, { cache: 'no-store' })).text()).includes(API)) live = true;
    }
  } catch {
    // not reachable yet
  }
  if (!live && i < tries - 1) await sleep(15_000);
}
live ? ok(`the published site is built against ${API}`) : fail(`after ${Math.round((tries * 15) / 60)} min ${SITE} is still not the build for ${API}`);

// 2. the API, and CORS for the site's origin
const origin = new URL(SITE).origin;
const res = await fetch(`${API}/api/state`, { headers: { origin } }).catch((e) => ({ ok: false, statusText: String(e), headers: new Headers() }));
const state = res.ok ? await res.json() : null;
state ? ok(`API answers: mode ${state.bot.mode}, ${state.portfolio.ratCount} rats, coin ${state.coin.mint ?? 'not launched yet'}`) : fail(`${API}/api/state: ${res.status ?? ''} ${res.statusText}`);
const allow = res.headers.get('access-control-allow-origin');
allow === origin || allow === '*' ? ok(`CORS allows ${origin}`) : fail(`CORS: the API allows ${allow ?? 'no origin'}, not ${origin}`);

// 3. the page, desktop and phone
if (state) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 375, height: 812 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(SITE, { waitUntil: 'load' });
    await page.waitForTimeout(10_000);
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    const banner = { dry_run: 'DRY RUN:', paused: 'PAUSED:', live: null }[state.bot.mode];
    // layout: nothing in the HUD runs off the screen, and the leaderboard never sits on the feed's rows
    const layout = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      const off = [...document.querySelectorAll('.hud *')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      }).length;
      const feed = box('.feed');
      const board = box('.board');
      const overlap =
        feed && board && feed.height > 0 && board.height > 0 &&
        board.bottom > feed.top + 1 && board.top < feed.bottom - 1 && board.right > feed.left + 1 && board.left < feed.right - 1;
      return { off, overlap: Boolean(overlap) };
    });
    const checks = [
      [errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`],
      [!/Waiting for the API|Connecting to the trading floor|Reconnecting to the trading floor/.test(text), 'the page reached the API'],
      [!/SIMULATION/.test(text), 'no simulator'],
      [banner ? text.includes(banner) : !/DRY RUN:|PAUSED:/.test(text), banner ? `the ${banner.replace(':', '')} banner is shown` : 'no DRY RUN or PAUSED banner (live)'],
      [new RegExp(`RATS HIRED ${state.portfolio.ratCount.toLocaleString('en-US')}\\b`).test(text), `RATS HIRED ${state.portfolio.ratCount}`],
      [state.coin.mint ? true : /pre-launch/.test(text), state.coin.mint ? 'coin launched' : 'market cap says pre-launch'],
      [layout.off === 0, `nothing in the HUD is off the screen${layout.off ? ` (${layout.off} elements are)` : ''}`],
      [!layout.overlap, 'the leaderboard does not cover the live feed'],
    ];
    for (const [pass, what] of checks) (pass ? ok : fail)(`${name}: ${what}`);
    await page.screenshot({ path: `site-${name}.png` }).catch(() => {});
    await page.close();
  }
  await browser.close();
}
console.log(fails.length ? `\nSITE CHECK FAILED (${fails.length})` : '\nSITE CHECK PASSED');
process.exit(fails.length ? 1 : 0);
