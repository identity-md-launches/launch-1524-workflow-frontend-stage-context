// Read-only public-RPC inspection from a real browser origin. Never requests a wallet or writes a transaction.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters, parseUnits } from 'viem';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = resolve(root, 'dist');
const manifest = JSON.parse(await readFile(resolve(dist, 'imd-deployment.json'), 'utf8'));
const contracts = Object.fromEntries(await Promise.all(manifest.contracts.map(async c => [c.name, { ...c, abi: JSON.parse(await readFile(resolve(dist, c.abiPath), 'utf8')) }])));
const quoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)', 'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)']);
const poolId = keccak256(encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'), [manifest.poolKey]));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/preview\//, '') || 'index.html';
    const file = resolve(dist, relative);
    if (!file.startsWith(`${dist}/`)) throw new Error('Invalid file');
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { chromium } = await import(process.env.IMD_PLAYWRIGHT ? pathToFileURL(process.env.IMD_PLAYWRIGHT).href : 'playwright');
const browser = await chromium.launch({ headless: true });
const evidence = { checkedAt: new Date().toISOString(), browser: browser.version(), mode: 'Read-only HTTP JSON-RPC from Chromium; no wallet, no signatures, no transactions.', endpoints: [] };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await page.goto(`http://127.0.0.1:${server.address().port}/preview/`, { waitUntil: 'networkidle' });
  const calls = [
    { name: 'chainId', method: 'eth_chainId', params: [] },
    { name: 'blockNumber', method: 'eth_blockNumber', params: [] },
    ...manifest.contracts.map(c => ({ name: `${c.name}.code`, method: 'eth_getCode', params: [c.address, 'latest'] })),
    ...[['LaunchToken', 'name'], ['LaunchToken', 'symbol'], ['LaunchToken', 'decimals'], ['JobZero', 'owner'], ['JobZero', 'token'], ['JobZero', 'isOpen'], ['JobZero', 'currentRun'], ['JobZero', 'totalBurned'], ['JobZero', 'handoffFee']].map(([contract, fn]) => ({ name: `${contract}.${fn}`, contract, fn, method: 'eth_call', params: [{ to: contracts[contract].address, data: encodeFunctionData({ abi: contracts[contract].abi, functionName: fn }) }, 'latest'] })),
  ];
  for (const [input, output, symbol] of [[manifest.network.pairToken.address, contracts.LaunchToken.address, 'IMDToTEYO'], [contracts.LaunchToken.address, manifest.network.pairToken.address, 'TEYOToIMD']]) {
    calls.push({ name: `quote.${symbol}`, quote: true, fn: 'quoteExactInputSingle', method: 'eth_call', params: [{ to: manifest.network.uniswapV4.quoter, data: encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: manifest.poolKey, zeroForOne: input.toLowerCase() === manifest.poolKey.currency0.toLowerCase(), exactAmount: 10n ** 18n, hookData: '0x' }] }) }, 'latest'] });
  }
  for (const amount of ['0.000001', '1000', '1000000']) {
    calls.push({ name: `quote.TEYOToIMD.${amount}`, quote: true, amount, fn: 'quoteExactInputSingle', method: 'eth_call', params: [{ to: manifest.network.uniswapV4.quoter, data: encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: manifest.poolKey, zeroForOne: contracts.LaunchToken.address.toLowerCase() === manifest.poolKey.currency0.toLowerCase(), exactAmount: parseUnits(amount, 18), hookData: '0x' }] }) }, 'latest'] });
  }
  for (const fn of ['getSlot0', 'getLiquidity']) calls.push({ name: `stateView.${fn}`, stateView: true, fn, method: 'eth_call', params: [{ to: manifest.network.uniswapV4.stateView, data: encodeFunctionData({ abi: stateViewAbi, functionName: fn, args: [poolId] }) }, 'latest'] });
  evidence.poolId = poolId;
  for (const endpoint of manifest.network.rpcUrls) {
    const row = { endpoint, results: {} };
    try {
      const response = await page.evaluate(async ({ endpoint, calls }) => {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calls.map((call, index) => ({ jsonrpc: '2.0', id: index + 1, method: call.method, params: call.params }))), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }, { endpoint, calls });
      if (!Array.isArray(response)) throw new Error(`Expected a batch response: ${JSON.stringify(response)}`);
      for (const [index, call] of calls.entries()) {
        const result = response.find(x => x.id === index + 1);
        if (result?.error) { row.results[call.name] = { error: result.error }; continue; }
        if (!result) { row.results[call.name] = { error: 'Response missing' }; continue; }
        if (call.name.endsWith('.code')) row.results[call.name] = { bytes: (result.result.length - 2) / 2, sha256: createHash('sha256').update(Buffer.from(result.result.slice(2), 'hex')).digest('hex') };
        else if (call.quote) { const [amountOut, gasEstimate] = decodeFunctionResult({ abi: quoterAbi, functionName: call.fn, data: result.result }); row.results[call.name] = { inputAmount: parseUnits(call.amount ?? '1', 18).toString(), amountOut, gasEstimate, decimals: 18, mode: 'eth_call only' }; }
        else if (call.stateView) row.results[call.name] = decodeFunctionResult({ abi: stateViewAbi, functionName: call.fn, data: result.result });
        else if (call.contract) row.results[call.name] = decodeFunctionResult({ abi: contracts[call.contract].abi, functionName: call.fn, data: result.result });
        else row.results[call.name] = BigInt(result.result).toString();
      }
    } catch (error) { row.error = error.message; }
    evidence.endpoints.push(row);
  }
  await mkdir(resolve(root, 'docs/evidence'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'docs/evidence/live-390.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(root, 'docs/evidence/live-1440.png'), fullPage: false });
  evidence.visibleStatus = await page.getByTestId('job-status').innerText();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
const serialized = JSON.stringify(evidence, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
await writeFile(resolve(root, 'docs/frontend-live-reads.json'), `${serialized}\n`);
console.log(serialized);
