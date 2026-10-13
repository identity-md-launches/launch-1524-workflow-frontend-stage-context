// Isolated deterministic chain fixtures for browser validation. Never imported by the application.
import { readFile } from 'node:fs/promises';
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, erc20Abi, parseAbi, zeroAddress, toHex } from 'viem';

export const fixtureWallets = {
  visitor: '0x1111111111111111111111111111111111111111',
  worker: '0x2222222222222222222222222222222222222222',
  earlier: '0x3333333333333333333333333333333333333333',
  recipient: '0x4444444444444444444444444444444444444444',
  owner: '0x5555555555555555555555555555555555555555',
  queued: '0x6666666666666666666666666666666666666666',
};
const unit = 10n ** 18n;
const blockHash = `0x${'ab'.repeat(32)}`;
const permitAbi = parseAbi([
  'function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
]);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);
const routerAbi = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']);
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);
const key = (...xs) => xs.map(String).map(x => x.toLowerCase()).join(':');

export async function createMockChain(dist, options = {}) {
  const manifest = JSON.parse(await readFile(`${dist}/imd-deployment.json`, 'utf8'));
  const deployed = Object.fromEntries(await Promise.all(manifest.contracts.map(async c => [c.name, { ...c, abi: JSON.parse(await readFile(`${dist}/${c.abiPath}`, 'utf8')) }])));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const scenario = options.scenario ?? 'visitor';
  const state = {
    account: fixtureWallets[scenario] ?? fixtureWallets.visitor,
    now, chainId: manifest.chainId, currentRun: options.currentRun ?? (scenario === 'idle' || scenario === 'owner' ? 0n : 3n),
    isOpen: !['idle', 'owner', 'closed'].includes(scenario), tokenSet: scenario !== 'owner',
    worker: fixtureWallets.worker, deadline: now + (scenario === 'expired' ? -60n : 82_800n),
    allowance: options.allowance ?? 0n, pairAllowance: options.pairAllowance ?? 0n,
    permitAllowance: options.permitAllowance ?? 0n, queueJoined: scenario === 'online', queueActive: scenario === 'online',
    claimed: new Set(), txs: [], calls: [], receipts: new Map(), errors: [],
    rejectNext: false, revertNext: null, rpcFailure: options.rpcFailure ?? false, receiptDelay: 0,
    delays: {}, totalBurned: 2530n * unit, bounty: options.bounty ?? 11515n * unit, fee: options.fee ?? 1060900000000000000000n,
    balance: options.balance ?? 123456789012345678901234567890n,
  };
  if (options.account) state.account = options.account;
  const attempts = [
    { worker: state.worker, startedAt: now - 3600n, endedAt: 0n, status: 0 },
    { worker: fixtureWallets.earlier, startedAt: now - 4000n, endedAt: now - 3600n, status: 1 },
    { worker: fixtureWallets.owner, startedAt: now - 6000n, endedAt: now - 4000n, status: 1 },
  ];
  const queue = [{ worker: fixtureWallets.recipient, onlineAt: now - 300n }, { worker: fixtureWallets.queued, onlineAt: now - 60n }];
  for (let i = attempts.length; i < (options.attemptCount ?? attempts.length); i++) attempts.push({ worker: `0x${(1000 + i).toString(16).padStart(40, '0')}`, startedAt: now - BigInt(i + 1) * 3600n, endedAt: now - BigInt(i) * 3600n, status: 1 });
  for (let i = queue.length; i < (options.queueCount ?? queue.length); i++) queue.push({ worker: `0x${(2000 + i).toString(16).padStart(40, '0')}`, onlineAt: now - BigInt(i + 1) * 60n });
  function run(id) {
    if (BigInt(id) === 0n) return { attempts: 0n, bounty: 0n, fee: 0n, openedAt: 0n, closedAt: 0n, failedWorker: zeroAddress, worker: zeroAddress, deadline: 0n, share: 0n, claimedCount: 0n, closed: false };
    const current = BigInt(id) === state.currentRun;
    const closed = !current || !state.isOpen;
    return {
      attempts: current ? BigInt(attempts.length) : 3n, bounty: current ? state.bounty : 11000n * unit,
      fee: current ? state.fee : 1030n * unit, openedAt: now - 172800n,
      closedAt: closed ? now - 86400n : 0n, failedWorker: closed ? fixtureWallets.recipient : zeroAddress,
      worker: current ? state.worker : fixtureWallets.recipient, deadline: current ? state.deadline : now - 86400n,
      share: closed ? 5500n * unit : 0n, claimedCount: BigInt(state.claimed.size), closed,
    };
  }
  function jobResult(name, args = []) {
    const account = args.at(-1);
    switch (name) {
      case 'owner': return fixtureWallets.owner;
      case 'token': return state.tokenSet ? deployed.LaunchToken.address : zeroAddress;
      case 'currentRun': return state.currentRun;
      case 'isOpen': return state.isOpen;
      case 'worker': return state.isOpen ? state.worker : zeroAddress;
      case 'deadline': return state.isOpen ? state.deadline : 0n;
      case 'handoffFee': return state.fee;
      case 'OPEN_FEE': return 10000n * unit;
      case 'ONLINE_FEE': return 10n * unit;
      case 'INITIAL_HANDOFF_FEE': return 1000n * unit;
      case 'WORKER_WINDOW': return 86400n;
      case 'MAX_PAGE_SIZE': return 100n;
      case 'BURN_ADDRESS': return '0x000000000000000000000000000000000000dEaD';
      case 'totalBurned': return state.totalBurned;
      case 'totalLiability': return state.bounty + 11000n * unit;
      case 'biggestBounty': return 25000n * unit;
      case 'mostHandoffs': return 12n;
      case 'longestRun': return [1n, 259200n];
      case 'runs': return run(args[0]);
      case 'workerStats': return [3n, 2n, 5500n * unit, 0n];
      case 'queueLength': return state.isOpen ? BigInt(queue.length + Number(state.queueActive)) : 0n;
      case 'isOnline': return state.queueActive && key(account) === key(state.account);
      case 'hasJoinedQueue': return state.queueJoined && key(account) === key(state.account);
      case 'hasHeld': return [state.worker, fixtureWallets.earlier, fixtureWallets.owner].some(w => key(w) === key(account));
      case 'claimed': return state.claimed.has(key(args[0], args[1]));
      case 'claimable': return run(args[0]).closed && key(args[1]) !== key(fixtureWallets.recipient) && !state.claimed.has(key(args[0], args[1])) ? 5500n * unit : 0n;
      case 'getAttempts': return attempts.slice(Number(args[1]), Number(args[1]) + Number(args[2]));
      case 'getQueue': return state.isOpen ? [...(state.queueActive ? [{ worker: state.account, onlineAt: now }] : []), ...queue].slice(Number(args[1]), Number(args[1]) + Number(args[2])) : [];
      default: return undefined;
    }
  }
  function decode(tx) {
    const address = key(tx.to);
    const contract = Object.values(deployed).find(c => key(c.address) === address);
    const protocol = manifest.network.uniswapV4;
    const abi = contract?.abi ?? (address === key(protocol.permit2) ? permitAbi : address === key(protocol.quoter) ? quoterAbi : address === key(protocol.universalRouter) ? routerAbi : address === key(protocol.stateView) ? stateViewAbi : erc20Abi);
    return { ...decodeFunctionData({ abi, data: tx.data ?? tx.input }), abi, address, contract };
  }
  function mutate(call, tx) {
    const { functionName: name, args = [], address } = call;
    if (name === 'approve') {
      if (address === key(manifest.network.uniswapV4.permit2)) state.permitAllowance = args[2];
      else if (address === key(deployed.LaunchToken.address)) state.allowance = args[1];
      else state.pairAllowance = args[1];
    }
    if (name === 'setToken') state.tokenSet = true;
    if (name === 'open') { state.currentRun += 1n; state.isOpen = true; state.worker = tx.from; state.deadline = now + 86400n; state.bounty = 10000n * unit; attempts.splice(0, attempts.length, { worker: tx.from, startedAt: now, endedAt: 0n, status: 0 }); }
    if (name === 'handoff') { attempts[0].endedAt = now; attempts[0].status = 1; state.worker = args[0]; state.deadline = now + 86400n; state.bounty += state.fee / 2n; state.totalBurned += state.fee / 2n; state.fee = state.fee * 103n / 100n; attempts.unshift({ worker: args[0], startedAt: now, endedAt: 0n, status: 0 }); }
    if (name === 'goOnline') { state.queueActive = true; state.queueJoined = true; state.totalBurned += 10n * unit; }
    if (name === 'goOffline') state.queueActive = false;
    if (name === 'timeout') state.isOpen = false;
    if (name === 'claim') state.claimed.add(key(args[0], tx.from));
  }
  async function request(method, params = []) {
    state.calls.push({ method, params });
    if (state.rpcFailure && !['eth_accounts', 'eth_requestAccounts'].includes(method)) throw { code: -32000, message: 'Fixture RPC unavailable' };
    if (method === 'eth_chainId') return toHex(state.chainId);
    if (method === 'net_version') return String(state.chainId);
    if (method === 'eth_getCode') return options.missingCode ? '0x' : '0x6001600055';
    if (method === 'eth_blockNumber') return '0x1900000';
    if (method === 'eth_getBalance') return toHex(5n * unit);
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
    if (method === 'eth_estimateGas') return '0x493e0';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_getBlockByNumber') return { number: '0x1900000', hash: blockHash, parentHash: blockHash, nonce: '0x0000000000000000', sha3Uncles: blockHash, logsBloom: `0x${'00'.repeat(256)}`, transactionsRoot: blockHash, stateRoot: blockHash, receiptsRoot: blockHash, miner: zeroAddress, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: toHex(state.now), transactions: [], uncles: [], baseFeePerGas: '0x3b9aca00' };
    if (method === 'eth_getTransactionReceipt') { if (state.receiptDelay > 0) { state.receiptDelay -= 1; return null; } return state.receipts.get(params[0]) ?? null; }
    if (method === 'eth_getTransactionByHash') { const tx = state.txs.find(x => x.hash === params[0]); return tx ? { hash: tx.hash, from: tx.from, to: tx.to, blockHash, blockNumber: '0x1900000', transactionIndex: '0x0', nonce: '0x0', gas: '0x493e0', gasPrice: '0x3b9aca00', value: tx.value ?? '0x0', input: tx.data, r: blockHash, s: blockHash, v: '0x1b', type: '0x0' } : null; }
    if (method === 'eth_call') {
      const tx = params[0]; const call = decode(tx); const { functionName: name, args = [], abi, address } = call;
      if (state.delays[name]) await new Promise(resolve => setTimeout(resolve, state.delays[name]));
      let result;
      const write = abi.find(x => x.type === 'function' && x.name === name)?.stateMutability;
      if (state.revertNext && !['view', 'pure'].includes(write)) { const error = state.revertNext; throw { code: 3, message: `execution reverted: ${error}`, data: encodeErrorResult({ abi: deployed.JobZero.abi, errorName: error }) }; }
      if (address === key(deployed.JobZero.address)) result = jobResult(name, args);
      else if (['approve', 'transfer', 'transferFrom'].includes(name) && address !== key(manifest.network.uniswapV4.permit2)) result = true;
      else if (name === 'quoteExactInputSingle') result = [args[0].exactAmount * 2n, 150000n];
      else if (name === 'getSlot0') result = [2n ** 96n, 0, 0, manifest.poolKey.fee];
      else if (name === 'decimals') result = 18;
      else if (name === 'symbol') result = address === key(deployed.LaunchToken.address) ? 'TEYO' : manifest.network.pairToken.symbol;
      else if (name === 'name') result = address === key(deployed.LaunchToken.address) ? 'Teyo' : manifest.network.pairToken.name;
      else if (name === 'totalSupply') result = 1000000000n * unit;
      else if (name === 'balanceOf') result = state.balance;
      else if (name === 'allowance') result = address === key(manifest.network.uniswapV4.permit2) ? [state.permitAllowance, now + 86400n, 0n] : address === key(deployed.LaunchToken.address) ? state.allowance : state.pairAllowance;
      if (result === undefined && ['view', 'pure'].includes(write)) throw new Error(`Unmocked read ${name}`);
      return encodeFunctionResult({ abi, functionName: name, result });
    }
    if (method === 'eth_sendTransaction') {
      if (state.rejectNext) { state.rejectNext = false; throw { code: 4001, message: 'User rejected the request.' }; }
      const tx = params[0]; const call = decode(tx); const hash = `0x${(state.txs.length + 1).toString(16).padStart(64, '0')}`;
      state.txs.push({ ...tx, hash, functionName: call.functionName, args: call.args }); mutate(call, tx);
      state.receipts.set(hash, { transactionHash: hash, transactionIndex: '0x0', blockHash, blockNumber: '0x1900000', from: tx.from, to: tx.to, cumulativeGasUsed: '0x493e0', gasUsed: '0x493e0', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x0', effectiveGasPrice: '0x3b9aca00' });
      return hash;
    }
    throw new Error(`Unmocked RPC method ${method}`);
  }
  async function route(route) {
    let payload;
    try { payload = route.request().postDataJSON(); } catch { return route.abort(); }
    const one = async item => { try { return { jsonrpc: '2.0', id: item.id, result: await request(item.method, item.params) }; } catch (e) { state.errors.push({ method: item.method, message: e.message }); return { jsonrpc: '2.0', id: item.id, error: { code: e.code ?? -32603, message: e.message, ...(e.data ? { data: e.data } : {}) } }; } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(payload) ? await Promise.all(payload.map(one)) : await one(payload)) });
  }
  return { manifest, deployed, state, request, route };
}

export async function installWallet(page, chain, options = {}) {
  await page.exposeBinding('__fixtureRpc', async (_source, method, params) => {
    try { return { result: await chain.request(method, params) }; }
    catch (e) { return { error: { code: e.code ?? -32603, message: e.message, ...(e.data ? { data: e.data } : {}) } }; }
  });
  await page.addInitScript(({ account, chainId, wrongChain, unknownChain, rejection }) => {
    const listeners = new Map();
    let currentChain = wrongChain ? '0xaa36a7' : `0x${chainId.toString(16)}`;
    let connected = false; let missing = unknownChain;
    window.__walletCalls = [];
    const emit = (name, arg) => (listeners.get(name) ?? []).forEach(fn => fn(arg));
    window.__wallet = { changeAccount(next) { account = next; connected = true; emit('accountsChanged', [next]); }, changeChain(next) { currentChain = next; emit('chainChanged', next); }, disconnect() { connected = false; emit('accountsChanged', []); } };
    window.ethereum = {
      isMetaMask: true, on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); }, removeListener(name, fn) { listeners.set(name, (listeners.get(name) ?? []).filter(x => x !== fn)); },
      async request({ method, params = [] }) {
        window.__walletCalls.push({ method, params });
        if (method === 'eth_accounts') return connected ? [account] : [];
        if (method === 'eth_requestAccounts') { if (rejection) { rejection = false; throw Object.assign(new Error('User rejected the connection request.'), { code: 4001 }); } connected = true; return [account]; }
        if (method === 'eth_chainId') return currentChain;
        if (method === 'wallet_switchEthereumChain') { if (missing) throw Object.assign(new Error('Unknown chain'), { code: 4902 }); currentChain = params[0].chainId; emit('chainChanged', currentChain); return null; }
        if (method === 'wallet_addEthereumChain') { missing = false; return null; }
        if (method === 'wallet_getCapabilities') return {};
        const response = await window.__fixtureRpc(method, params);
        if (response.error) throw Object.assign(new Error(response.error.message), response.error);
        return response.result;
      },
    };
  }, { account: chain.state.account, chainId: chain.manifest.chainId, wrongChain: options.wrongChain ?? false, unknownChain: options.unknownChain ?? false, rejection: options.rejection ?? false });
}
