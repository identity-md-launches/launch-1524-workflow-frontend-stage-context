import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { addressIssue, AppError, countdown, errorMessage, readGame, readHistory, tokens, type GameSnapshot, type Run } from '../src/game';
import { tokenConfigured, transactionReceiptFailure } from '../src/useGame';
import type { RuntimeConfig } from '../src/config';

const deployment = JSON.parse(readFileSync(new URL('../config/deployment.json', import.meta.url), 'utf8'));
const contracts = Object.fromEntries(deployment.contracts.map((contract: { name: string }) => [contract.name, {
  ...contract,
  abi: JSON.parse(readFileSync(new URL(`../config/abi/${contract.name}.json`, import.meta.url), 'utf8')),
}]));
const config = { contracts, manifest: deployment } as RuntimeConfig;
const account = deployment.poolKey.currency1 as Address;
const run: Run = { attempts: 3n, bounty: 12_000n, fee: 1_060n, openedAt: 100n, closedAt: 0n, failedWorker: zeroAddress, worker: account, deadline: 86_500n, share: 0n, claimedCount: 0n, closed: false };

test('ordinary viem RPC errors are safe, nested rejection is readable, and custom errors retain guidance', () => {
  assert.match(errorMessage(new BaseError('RPC connection failed')), /Check your wallet and connection/);
  const declined = new BaseError('Wallet failed', { cause: Object.assign(new Error('Denied'), { code: 4001 }) });
  assert.match(errorMessage(declined), /Request declined/);
  assert.equal(errorMessage(new AppError('The run changed. Review the new fee.')), 'The run changed. Review the new fee.');
  const reverted = new ContractFunctionRevertedError({
    abi: contracts.JobZero.abi, functionName: 'handoff',
    data: encodeErrorResult({ abi: contracts.JobZero.abi, errorName: 'AlreadyHeld' }),
  });
  assert.match(errorMessage(new BaseError('Simulation failed', { cause: reverted })), /already held the job/);
  assert.match(errorMessage(new Error('insufficient funds for gas')), /enough ETH/);
  assert.doesNotThrow(() => errorMessage(undefined));
});

test('recipient validation rejects zero, self, ENS and invalid text before simulation', () => {
  assert.match(addressIssue(zeroAddress, account)!, /nonzero/);
  assert.match(addressIssue(getAddress(account), account)!, /yourself/);
  assert.match(addressIssue('worker.eth', account)!, /Ethereum address/);
  assert.match(addressIssue('not an address', account)!, /Ethereum address/);
  assert.equal(addressIssue(contracts.JobZero.address, account), undefined);
});

test('token amounts preserve large integer precision, units and tiny positive balances', () => {
  assert.equal(tokens(123456789012345678901234567890123456n), '123,456,789,012,345,678.9012');
  assert.equal(tokens(1234567n, 6), '1.2345');
  assert.equal(tokens(1n), '<0.0001');
  assert.equal(tokens(0n), '0');
  assert.equal(tokens(undefined), '—');
  assert.equal(countdown(86_400), '24:00:00');
  assert.equal(countdown(90_061), '25:01:01');
  assert.equal(countdown(-1), '00:00:00');
});

test('cancelled or changed replacement receipts never report original action success', () => {
  assert.match(transactionReceiptFailure('success', 'cancelled')!, /cancelled/);
  assert.match(transactionReceiptFailure('success', 'replaced')!, /different action/);
  assert.match(transactionReceiptFailure('reverted', 'repriced')!, /reverted/);
  assert.equal(transactionReceiptFailure('success', 'repriced'), undefined);
  assert.equal(transactionReceiptFailure('success'), undefined);
});

test('gameplay needs the exact attested token, not merely an initialized token', () => {
  assert.equal(tokenConfigured(undefined, config), false);
  assert.equal(tokenConfigured({ token: zeroAddress } as GameSnapshot, config), false);
  assert.equal(tokenConfigured({ token: account } as GameSnapshot, config), false);
  assert.equal(tokenConfigured({ token: getAddress(contracts.LaunchToken.address) } as GameSnapshot, config), true);
});

test('live snapshot reads all public and wallet state at one block using the configured spender', async () => {
  const calls: Array<{ functionName: string; blockNumber: bigint; args?: readonly unknown[]; address: Address }> = [];
  const values: Record<string, unknown> = {
    currentRun: 1n, isOpen: true, owner: account, token: contracts.LaunchToken.address,
    totalBurned: 2_000n, biggestBounty: 12_000n, mostHandoffs: 2n, longestRun: [1n, 100n], OPEN_FEE: 10_000n, ONLINE_FEE: 10n, handoffFee: 1_060n,
    decimals: 18, symbol: 'TEYO', runs: run, queueLength: 1n,
    getQueue: [{ worker: contracts.JobZero.address, onlineAt: 90n }],
    getAttempts: [{ worker: account, startedAt: 100n, endedAt: 0n, status: 0 }],
    balanceOf: 100_000n, allowance: 1_060n, hasHeld: true, hasJoinedQueue: false, isOnline: false, workerStats: [3n, 2n, 0n, 0n],
  };
  const client = {
    getBlock: async () => ({ number: 12_345n, timestamp: 500n }),
    readContract: async (call: typeof calls[number]) => { calls.push(call); assert.ok(call.functionName in values); return values[call.functionName]; },
  } as unknown as PublicClient;
  const snapshot = await readGame(client, config, account);
  assert.equal(snapshot.block, 12_345n);
  assert.equal(snapshot.run?.worker, account);
  assert.equal(snapshot.wallet, account);
  assert.equal(snapshot.hasHeld, true);
  assert.equal(snapshot.allowance, 1_060n);
  assert.ok(calls.every(call => call.blockNumber === snapshot.block));
  const allowance = calls.find(call => call.functionName === 'allowance')!;
  assert.equal(allowance.address, contracts.LaunchToken.address);
  assert.deepEqual(allowance.args, [account, contracts.JobZero.address]);
  calls.length = 0;
  const publicSnapshot = await readGame(client, config);
  assert.equal(publicSnapshot.wallet, undefined);
  assert.ok(!calls.some(call => call.functionName === 'balanceOf'));
});

test('history pagination is newest-first, block-pinned and never requests a nonexistent zero run', async () => {
  const calls: Array<{ functionName: string; blockNumber: bigint; args: readonly unknown[] }> = [];
  const client = {
    readContract: async (call: typeof calls[number]) => {
      calls.push(call);
      return call.functionName === 'runs' ? run : call.functionName === 'claimable' ? 10n : false;
    },
  } as unknown as PublicClient;
  const page = await readHistory(client, config, 25n, 12_345n, account);
  assert.equal(page.length, 20);
  assert.equal(page[0].id, 25n);
  assert.equal(page[19].id, 6n);
  assert.ok(calls.every(call => call.blockNumber === 12_345n));
  assert.ok(calls.filter(call => call.functionName !== 'runs').every(call => call.args[1] === account));
  assert.equal((await readHistory(client, config, 1n, 12_345n, account)).length, 1);
  assert.deepEqual(await readHistory(client, config, 0n, 12_345n, account), []);
});
