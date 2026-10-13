// Production-export browser tests. All external requests are intercepted; no chain writes occur.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMockChain, fixtureWallets, installWallet } from './mock-rpc.mjs';
import { decodeAbiParameters, formatUnits, parseAbiParameters } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDist = resolve(root, 'dist');
const output = resolve(root, 'test/scratch/browser');
await mkdir(output, { recursive: true });
const dist = resolve(output, 'export');
await rm(dist, { recursive: true, force: true });
await cp(sourceDist, dist, { recursive: true });
const manifestSha256 = createHash('sha256').update(await readFile(resolve(dist, 'imd-deployment.json'))).digest('hex');
const playwright = await import(process.env.IMD_PLAYWRIGHT ? pathToFileURL(process.env.IMD_PLAYWRIGHT).href : 'playwright');
let AxeBuilder;
if (process.env.IMD_AXE) ({ default: AxeBuilder } = await import(pathToFileURL(process.env.IMD_AXE).href));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname).replace(/^\/preview\//, '');
    const file = resolve(dist, pathname === '' ? 'index.html' : pathname);
    if (!file.startsWith(`${dist}/`)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = `${origin}/preview/`;
const results = [];
const artifacts = [];
const observations = [];
const engineVersions = {};
const engines = (process.env.BROWSER_ENGINES ?? 'chromium,webkit').split(',');
const only = process.env.BROWSER_CASE;
const unit = 10n ** 18n;
async function until(fn, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  assert.fail(message);
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function connect(page) { await button(page, 'Connect wallet').first().click(); await until(() => page.locator('.wallet-menu summary').count(), 'wallet connects'); }
async function txDone(chain, name, n = 1) { await until(() => chain.state.txs.filter(x => x.functionName === name).length >= n, `${name} transaction sent`); }
async function visible(locator) { await locator.waitFor({ state: 'visible', timeout: 12000 }); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${page.viewportSize().width}`); }
async function session(browser, options, fn) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; const resourceErrors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', response => { if (response.url().startsWith(origin) && response.status() >= 400) resourceErrors.push(`${response.status()} ${response.url()}`); });
  const chain = await createMockChain(dist, options);
  await context.route('**/*', async route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith(origin)) return route.continue();
    if (chain.manifest.network.rpcUrls.some(rpc => requestUrl.startsWith(rpc))) return chain.route(route);
    return route.abort('blockedbyclient');
  });
  if (options.wallet !== false) await installWallet(page, chain, options);
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await visible(page.getByRole('heading', { level: 1 }));
    await fn(page, chain, context);
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.deepEqual(resourceErrors, [], 'all local assets load at gateway subpath');
  } catch (error) {
    const file = resolve(output, `failure-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    await page.screenshot({ path: file.replace('.png', '-viewport.png'), fullPage: false });
    await writeFile(file.replace('.png', '.txt'), await page.locator('body').innerText());
    await writeFile(file.replace('.png', '.json'), JSON.stringify({ errors: chain.state.errors, txs: chain.state.txs, calls: chain.state.calls.slice(-20) }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    error.message += `\nFixture errors: ${JSON.stringify(chain.state.errors)}\nScreenshot: ${file}`;
    throw error;
  } finally { await context.close(); }
}

const cases = [
  ['disconnected-mobile-and-missing-wallet', async (browser, engine) => session(browser, { wallet: false }, async (page) => {
    const primary = button(page, 'Connect wallet').first();
    await visible(primary);
    const rect = await button(page, 'Connect to play').boundingBox();
    assert.ok(rect.y + rect.height <= 844, 'connect action on first 390px screen');
    for (const width of [320, 390, 768, 1440]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); }
    await page.setViewportSize({ width: 390, height: 844 });
    await primary.click(); await visible(page.getByText(/No browser wallet found/));
    await page.screenshot({ path: resolve(output, `${engine}-missing-wallet-390.png`), fullPage: true });
  })],
  ['unknown-chain-add-and-switch', async browser => session(browser, { wrongChain: true, unknownChain: true }, async (page, chain) => {
    await connect(page);
    await button(page, `Switch to ${chain.manifest.network.name}`).first().click();
    await until(async () => (await page.evaluate(() => window.__walletCalls)).filter(x => x.method === 'wallet_switchEthereumChain').length === 2, 'switch retried after add');
    const calls = await page.evaluate(() => window.__walletCalls);
    assert.deepEqual(calls.find(x => x.method === 'wallet_addEthereumChain').params, [chain.manifest.walletAddChain]);
    assert.equal(chain.state.txs.length, 0, 'no signing on wrong chain');
  })],
  ['connection-rejection-retry', async browser => session(browser, { rejection: true }, async page => {
    await button(page, 'Connect wallet').first().click(); await visible(page.getByText(/Request declined in your wallet/));
    await connect(page);
  })],
  ['open-approval-and-confirmed-refresh', async browser => session(browser, { scenario: 'idle' }, async (page, chain) => {
    await connect(page);
    chain.state.receiptDelay = 1;
    await button(page, /Approve.*TEYO/).first().click(); await txDone(chain, 'approve');
    assert.equal(await page.getByTestId('action-open').isDisabled(), true, 'action locked while approval receipt pending');
    await button(page, /Open JOB #0/).first().click(); await txDone(chain, 'open');
    assert.equal(chain.state.txs[0].to.toLowerCase(), chain.deployed.LaunchToken.address.toLowerCase());
    assert.equal(chain.state.txs[0].args[0].toLowerCase(), chain.deployed.JobZero.address.toLowerCase());
    assert.equal(chain.state.txs[0].args[1], 10000n * unit);
    assert.equal(chain.state.txs[1].to.toLowerCase(), chain.deployed.JobZero.address.toLowerCase());
    await visible(page.getByText('JOB #0 IS ASSIGNED TO YOU', { exact: true }));
  })],
  ...[7, 15].map(handoffs => [`worker-full-precision-approval-${handoffs}`, async (browser, engine) => {
    let fee = 1000n * unit; let bounty = 10000n * unit;
    for (let i = 0; i < handoffs; i++) { bounty += fee - fee / 2n; fee += fee * 3n / 100n; }
    await session(browser, { scenario: 'worker', allowance: 0n, attemptCount: handoffs + 1, fee, bounty }, async (page, chain) => {
      await connect(page);
      const action = page.getByTestId('action-handoff');
      await until(async () => await action.count() && await action.isEnabled(), 'worker approval ready');
      assert.equal(await page.evaluate(() => scrollY), 0, 'measure the first screen without scrolling');
      const rect = await action.boundingBox();
      const bar = await page.locator('.live-bar').boundingBox();
      observations.push({ engine, width: 390, handoffs, fee: fee.toString(), bounty: bounty.toString(), actionTop: rect.y, actionHeight: rect.height, actionBottom: rect.y + rect.height, liveBarTop: bar.y });
      const shot = `${engine}-worker-${handoffs}-handoffs-390.png`;
      await page.screenshot({ path: resolve(output, shot), fullPage: false }); artifacts.push(shot);
      assert.ok(rect.y + rect.height <= bar.y, `full-precision approval above live bar after ${handoffs} handoffs; bottom=${rect.y + rect.height}, bar=${bar.y}`);
      assert.equal(await action.getAttribute('aria-label'), null, 'visible copy supplies the accessible name');
      assert.match(await action.innerText(), /^Approve TEYO/);
      const exactFee = formatUnits(fee, 18);
      const exactBounty = formatUnits(bounty, 18);
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 844 }); await noOverflow(page);
        for (const [selector, amount] of [['.assignment p .token-amount', exactFee], ['.job-metrics > div:nth-child(3) .token-amount', exactFee], ['.job-metrics > div:first-child .token-amount', exactBounty]]) {
          const value = page.locator(selector);
          assert.equal(await value.getAttribute('title'), `${amount} TEYO`);
          assert.equal((await value.innerText()).replaceAll(',', ''), `${amount} TEYO`, 'exact amount remains in visible text');
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByLabel(/Next worker/).fill(fixtureWallets.recipient);
      await action.click(); await txDone(chain, 'approve');
      assert.equal(chain.state.txs[0].args[0].toLowerCase(), chain.deployed.JobZero.address.toLowerCase());
      assert.equal(chain.state.txs[0].args[1], fee, 'concise approval still authorizes the exact fee');
      await button(page, /Hand off JOB #0/).click(); await txDone(chain, 'handoff');
      assert.equal(chain.state.txs[1].args[0].toLowerCase(), fixtureWallets.recipient);
    });
  }]),
  ['worker-recipient-validation-handoff', async browser => session(browser, { scenario: 'worker', allowance: 2000n * unit }, async (page, chain) => {
    await connect(page);
    const mainAction = await page.getByTestId('action-handoff').boundingBox();
    const bar = await page.locator('.live-bar').boundingBox();
    observations.push({ engine: browser.browserType().name(), width: 390, actionBottom: mainAction.y + mainAction.height, liveBarTop: bar.y });
    assert.ok(mainAction.y + mainAction.height <= bar.y, `worker's handoff action visible above live bar; bottom=${mainAction.y + mainAction.height}, bar=${bar.y}`);
    const recipient = page.getByLabel(/Next worker/);
    await recipient.fill('not-an-address'); await button(page, 'Check worker').click(); await visible(page.getByText(/valid Ethereum address/));
    await recipient.fill(fixtureWallets.worker); await button(page, 'Check worker').click(); await visible(page.getByText(/yourself/));
    await recipient.fill(fixtureWallets.earlier); await button(page, 'Check worker').click(); await visible(page.getByText(/already held/));
    assert.equal(chain.state.txs.length, 0);
    await recipient.fill(fixtureWallets.recipient);
    await button(page, /Hand off JOB #0/).click(); await txDone(chain, 'handoff');
    assert.equal(chain.state.txs[0].args[0].toLowerCase(), fixtureWallets.recipient);
  })],
  ['queue-join-leave-no-rejoin', async browser => session(browser, { scenario: 'visitor' }, async (page, chain) => {
    await connect(page);
    await button(page, /Approve.*TEYO/).first().click(); await txDone(chain, 'approve');
    await button(page, 'Go online').first().click(); await txDone(chain, 'goOnline');
    await button(page, 'Go offline').click(); await txDone(chain, 'goOffline');
    await visible(page.getByText(/already used this run’s queue entry/));
    assert.equal(chain.state.txs[0].args[1], 10n * unit);
  })],
  ['expired-timeout-and-closed-state', async browser => session(browser, { scenario: 'expired' }, async (page, chain) => {
    await connect(page); await button(page, 'Force timeout').click(); await txDone(chain, 'timeout');
    await visible(button(page, /Open JOB #0|Approve.*TEYO/).first());
    assert.equal(chain.state.isOpen, false);
  })],
  ['claim-past-run-once', async browser => session(browser, { scenario: 'closed' }, async (page, chain) => {
    await connect(page); await button(page, /Claim.*TEYO|Claim.*run/).first().click(); await txDone(chain, 'claim');
    assert.ok(chain.state.claimed.size === 1);
  })],
  ['owner-one-time-setup', async browser => session(browser, { scenario: 'owner' }, async (page, chain) => {
    await connect(page); await page.getByLabel('I understand this token cannot be changed.').check(); await button(page, 'Set TEYO permanently').click(); await txDone(chain, 'setToken');
    assert.equal(chain.state.txs[0].args[0].toLowerCase(), chain.deployed.LaunchToken.address.toLowerCase());
    await until(() => button(page, 'Set TEYO permanently').count().then(n => n === 0), 'setup disappears after token locks');
  })],
  ['signature-rejection-and-contract-revert', async browser => session(browser, { scenario: 'idle', allowance: 10000n * unit }, async (page, chain) => {
    await connect(page); chain.state.rejectNext = true;
    await button(page, /Open JOB #0/).first().click(); await visible(page.getByText(/Request declined in your wallet/));
    assert.equal(chain.state.txs.length, 0);
    chain.state.revertNext = 'RunAlreadyOpen';
    await button(page, /Open JOB #0/).first().click(); await visible(page.getByText(/Another worker opened a run/));
    assert.equal(chain.state.txs.length, 0);
    chain.state.revertNext = null;
    await button(page, /Open JOB #0/).first().click(); await txDone(chain, 'open');
  })],
  ['queue-row-one-tap-handoff', async browser => session(browser, { scenario: 'worker', allowance: 2000n * unit }, async (page, chain) => {
    await connect(page);
    await page.getByRole('button', { name: `Hand off to ${fixtureWallets.recipient}`, exact: true }).click();
    await txDone(chain, 'handoff');
    assert.equal(chain.state.txs[0].args[0].toLowerCase(), fixtureWallets.recipient);
  })],
  ['pagination-retention-and-specific-bounty', async browser => session(browser, { scenario: 'visitor', currentRun: 25n, queueCount: 25, attemptCount: 25 }, async (page, chain) => {
    await connect(page);
    await button(page, 'Load more workers').click(); await until(() => page.locator('#queue .data-list > li').count().then(n => n === 25), 'queue next page loaded');
    await button(page, 'Load more attempts').click(); await until(() => page.locator('#attempts .data-list > li').count().then(n => n === 25), 'attempt next page loaded');
    await button(page, 'Refresh ↻').click();
    await visible(button(page, 'Refresh queue list'));
    assert.equal(await page.locator('#queue .data-list > li').count(), 25, 'expanded queue retained across live refresh');
    assert.equal(await page.locator('#attempts .data-list > li').count(), 25, 'expanded attempts retained across live refresh');
    await button(page, 'Load older runs').click(); await visible(page.getByText(/^Showing runs 1–25 of 25/));
    await page.getByLabel('Check a specific run').fill('0'); await button(page, 'Check bounty').click();
    await visible(page.getByText('Enter an existing run number, starting at 1.', { exact: true }));
    await page.getByLabel('Check a specific run').fill('1'); await button(page, 'Check bounty').click(); await visible(button(page, 'Claim this bounty'));
    await button(page, 'Claim this bounty').click(); await txDone(chain, 'claim');
    assert.equal(chain.state.txs[0].args[0], 1n);
  })],
  ['stale-bounty-response-after-account-change', async browser => session(browser, { scenario: 'visitor' }, async (page, chain) => {
    await connect(page); await visible(button(page, 'Claim TEYO').first());
    chain.state.delays.claimable = 600;
    await page.getByLabel('Check a specific run').fill('1'); await button(page, 'Check bounty').click();
    await page.evaluate(account => window.__wallet.changeAccount(account), fixtureWallets.recipient);
    await page.waitForTimeout(850);
    assert.equal(await button(page, 'Claim this bounty').count(), 0, 'old account lookup cannot reappear');
    assert.equal(await button(page, 'Claim TEYO').count(), 0, 'old wallet history cannot show claim controls');
    assert.equal(chain.state.txs.length, 0);
  })],
  ['token-transfer-validation-and-account-change', async browser => session(browser, { scenario: 'worker' }, async (page, chain) => {
    await connect(page); await page.getByText('TEYO wallet tools', { exact: true }).click();
    await page.getByLabel('Recipient address', { exact: true }).fill('bad-address');
    await page.getByLabel('Amount in TEYO', { exact: true }).fill('1.25');
    await button(page, 'Send TEYO').click(); await visible(page.getByText('Enter a valid, nonzero recipient address.', { exact: true }));
    assert.equal(chain.state.txs.length, 0);
    await page.getByLabel('Recipient address', { exact: true }).fill(fixtureWallets.recipient);
    await button(page, 'Send TEYO').click(); await txDone(chain, 'transfer');
    assert.equal(chain.state.txs[0].args[1], 125n * unit / 100n);
    assert.equal(chain.state.txs[0].to.toLowerCase(), chain.deployed.LaunchToken.address.toLowerCase());
    await page.evaluate(account => window.__wallet.changeAccount(account), fixtureWallets.visitor);
    await until(() => page.getByText('JOB #0 IS ASSIGNED TO YOU', { exact: true }).count().then(n => n === 0), 'worker controls disappear after account change');
  })],
  ['deployment-code-and-rpc-failure-gates', async browser => {
    await session(browser, { missingCode: true, scenario: 'idle' }, async (page, chain) => {
      await connect(page); await visible(page.getByText(/deployed contract has no code/));
      assert.equal(chain.state.txs.length, 0);
      assert.equal(await button(page, /Open JOB #0/).count(), 0);
    });
    await session(browser, { rpcFailure: true }, async (page, chain) => {
      await visible(page.getByText(/Live reads are unavailable/));
      assert.equal(chain.state.txs.length, 0);
    });
  }],
  ['failed-worker-has-no-claim', async browser => session(browser, { scenario: 'closed', account: fixtureWallets.recipient }, async (page, chain) => {
    await connect(page);
    assert.equal(await button(page, /Claim.*TEYO|Claim.*run/).count(), 0);
    assert.equal(chain.state.txs.length, 0);
  })],
  ['buy-quote-two-approvals-and-swap', async browser => session(browser, { scenario: 'visitor' }, async (page, chain) => {
    await connect(page); await page.locator('#swap-amount').fill('10');
    await button(page, 'Get quote').click();
    await visible(page.getByText('20 TEYO', { exact: true }));
    assert.equal(chain.state.txs.length, 0, 'quote uses eth_call only');
    await button(page, '1. Approve IMD for Permit2').click(); await txDone(chain, 'approve', 1);
    await button(page, 'Get quote').click();
    await button(page, '2. Approve router in Permit2').click(); await txDone(chain, 'approve', 2);
    await button(page, 'Get quote').click();
    await button(page, '3. Swap IMD for TEYO').click(); await txDone(chain, 'execute');
    const [tokenApproval, permitApproval, swap] = chain.state.txs;
    const network = chain.manifest.network;
    assert.equal(tokenApproval.to.toLowerCase(), network.pairToken.address.toLowerCase());
    assert.equal(tokenApproval.args[0].toLowerCase(), network.uniswapV4.permit2.toLowerCase());
    assert.equal(tokenApproval.args[1], 10n * unit);
    assert.equal(permitApproval.to.toLowerCase(), network.uniswapV4.permit2.toLowerCase());
    assert.equal(permitApproval.args[0].toLowerCase(), network.pairToken.address.toLowerCase());
    assert.equal(permitApproval.args[1].toLowerCase(), network.uniswapV4.universalRouter.toLowerCase());
    assert.equal(swap.to.toLowerCase(), network.uniswapV4.universalRouter.toLowerCase());
    assert.equal(BigInt(swap.value ?? 0), 0n, 'ERC20 pair sends no ETH');
    assert.equal(swap.args[0], '0x10');
    const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), swap.args[1][0]);
    assert.equal(actions, '0x060c0f');
    const [execution] = decodeAbiParameters(parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'), params[0]);
    assert.equal(execution.poolKey.hooks.toLowerCase(), chain.manifest.poolKey.hooks.toLowerCase());
    assert.equal(execution.poolKey.currency0.toLowerCase(), chain.manifest.poolKey.currency0.toLowerCase());
    assert.equal(execution.poolKey.currency1.toLowerCase(), chain.manifest.poolKey.currency1.toLowerCase());
    assert.equal(execution.poolKey.fee, chain.manifest.poolKey.fee);
    assert.equal(execution.poolKey.tickSpacing, chain.manifest.poolKey.tickSpacing);
    assert.equal(execution.zeroForOne, false);
    assert.equal(execution.amountOutMinimum, 199n * unit / 10n);
    await visible(page.getByText(/Swap IMD for TEYO confirmed/));
  })],
  ['sell-validation-quote-invalidation', async browser => session(browser, { scenario: 'visitor', allowance: 100n * unit, permitAllowance: 100n * unit }, async (page, chain) => {
    await connect(page); await button(page, 'Sell TEYO').click();
    await page.locator('#swap-amount').fill('-1');
    assert.equal(await button(page, 'Get quote').isDisabled(), true);
    await page.locator('#swap-amount').fill('2'); await page.locator('#swap-slippage').fill('10');
    assert.equal(await button(page, 'Get quote').isDisabled(), true);
    await page.locator('#swap-slippage').fill('0.5'); await button(page, 'Get quote').click();
    await visible(button(page, '3. Swap TEYO for IMD'));
    await page.locator('#swap-amount').fill('3');
    assert.equal(await button(page, '3. Swap TEYO for IMD').count(), 0, 'editing invalidates quote');
    await button(page, 'Get quote').click(); await button(page, '3. Swap TEYO for IMD').click(); await txDone(chain, 'execute');
    assert.equal(chain.state.txs.length, 1, 'existing valid allowances skip approval');
  })],
  ['rendered-accessibility-layout-and-keyboard', async (browser, engine) => session(browser, { scenario: 'worker', allowance: 2000n * unit }, async (page, chain) => {
    await connect(page);
    await visible(page.getByText('JOB #0 IS ASSIGNED TO YOU', { exact: true }));
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 }); await noOverflow(page);
      const file = `${engine}-worker-${width}.png`;
      await page.screenshot({ path: resolve(output, file), fullPage: true }); artifacts.push(file);
      if (width === 390 || width === 1440) await page.screenshot({ path: resolve(output, `${engine}-worker-${width}-viewport.png`), fullPage: false });
    }
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator('.wallet-menu summary').click(); await noOverflow(page);
    const addressText = await page.locator('.wallet-menu-content').innerText();
    assert.ok(addressText.includes(fixtureWallets.worker), 'full wallet address is reachable in menu');
    await page.screenshot({ path: resolve(output, `${engine}-wallet-menu-320.png`), fullPage: false });
    await page.locator('.wallet-menu summary').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Control+Home'); await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, outline: getComputedStyle(document.activeElement).outlineStyle }));
    assert.notEqual(focus.tag, 'BODY'); assert.notEqual(focus.outline, 'none');
    await page.screenshot({ path: resolve(output, `${engine}-keyboard-focus-390.png`), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await noOverflow(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 390, height: 844 });
    if (AxeBuilder) {
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      await writeFile(resolve(output, `${engine}-axe.json`), JSON.stringify(audit, null, 2));
      assert.deepEqual(audit.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), []);
    }
    const animations = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
    assert.equal(animations, 0, 'reduced motion stops flicker');
    assert.equal(chain.state.txs.length, 0);
  })],
];

try {
  for (const engine of engines) {
    let browser;
    try {
      browser = await playwright[engine].launch({ headless: true });
      engineVersions[engine] = browser.version();
      for (const [name, run] of cases) {
        if (only && !name.includes(only)) continue;
        const started = Date.now();
        try { await run(browser, engine); results.push({ engine, name, passed: true, durationMs: Date.now() - started }); console.log(`PASS ${engine}: ${name}`); }
        catch (error) { results.push({ engine, name, passed: false, durationMs: Date.now() - started, error: error.stack }); console.error(`FAIL ${engine}: ${name}\n${error.stack}`); }
      }
    } catch (error) { results.push({ engine, name: 'browser-launch', passed: false, error: error.message }); console.error(error.message); }
    finally { await browser?.close(); }
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ url, manifestSha256, finishedAt: new Date().toISOString(), results, artifacts, observations, engineVersions }, null, 2));
}
console.log(`${results.filter(r => r.passed).length}/${results.length} browser cases passed.`);
if (results.some(r => !r.passed)) process.exitCode = 1;
