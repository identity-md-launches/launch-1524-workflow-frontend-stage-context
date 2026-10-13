import { BaseError, ContractFunctionRevertedError, formatUnits, getAddress, isAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import type { RuntimeConfig } from './config';

export interface Run {
  attempts: bigint; bounty: bigint; fee: bigint; openedAt: bigint; closedAt: bigint;
  failedWorker: Address; worker: Address; deadline: bigint; share: bigint; claimedCount: bigint; closed: boolean;
}
export interface Attempt { worker: Address; startedAt: bigint; endedAt: bigint; status: number }
export interface QueueEntry { worker: Address; onlineAt: bigint }
export interface GameSnapshot {
  block: bigint; timestamp: bigint; receivedAt: number; currentRun: bigint; isOpen: boolean;
  owner: Address; token: Address; totalBurned: bigint; biggestBounty: bigint; mostHandoffs: bigint;
  longestRun: readonly [bigint, bigint]; openFee: bigint; onlineFee: bigint; handoffFee: bigint;
  decimals: number; symbol: string; run?: Run; queueLength: bigint; queue: QueueEntry[]; attempts: Attempt[];
  wallet?: Address; balance?: bigint; allowance?: bigint; hasHeld?: boolean; joined?: boolean; online?: boolean;
  stats?: readonly [bigint,bigint,bigint,bigint];
}
export interface RunHistory { id: bigint; run: Run; claimable?: bigint; claimed?: boolean }
export const PAGE_SIZE = 20n;
export const sameAddress = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function tokens(n: bigint | undefined, decimals = 18, maxFraction = 4): string {
  if (n === undefined) return '—';
  const [whole, fraction = ''] = formatUnits(n, decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cut = fraction.slice(0, maxFraction).replace(/0+$/, '');
  if (n > 0n && whole === '0' && !cut && fraction) return `<0.${'0'.repeat(maxFraction - 1)}1`;
  return grouped + (cut ? `.${cut}` : '');
}
export function countdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return [Math.floor(safe / 3600), Math.floor(safe / 60) % 60, safe % 60].map(v => String(v).padStart(2, '0')).join(':');
}
export function dateTime(timestamp: bigint) {
  return new Date(Number(timestamp) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const messages: Record<string, string> = {
  Unauthorized: 'Only the contract owner can set TEYO.', TokenAlreadySet: 'The token is already locked. Refresh the explorer.',
  InvalidToken: 'The token could not be verified. Check the deployment configuration.', TokenNotConfigured: 'The owner must set TEYO before gameplay can begin.',
  RunAlreadyOpen: 'Another worker opened a run. Refresh to see it.', NoOpenRun: 'This run has closed. Refresh the explorer.',
  NotWorker: 'Only the current worker can hand off JOB #0.', DeadlinePassed: 'The deadline has passed. Anyone can now force timeout.',
  DeadlineNotReached: 'The deadline has not passed on chain. Wait for the next block.', InvalidRecipient: 'Choose a different, nonzero worker address.',
  AlreadyHeld: 'This address already held the job in this run. Choose a new worker.', AlreadyJoined: 'You already joined this run’s queue. Each wallet can enter only once.',
  NotOnline: 'You are no longer online in this run.', NothingToClaim: 'No share is available. This wallet may have claimed already.',
  ERC20InsufficientBalance: 'Your TEYO balance is too low for this action.', ERC20InsufficientAllowance: 'Approve the current TEYO fee, then try again.',
  UnexpectedTokenAmount: 'The contract did not receive the expected TEYO amount. No gameplay change was made.',
};
export function errorMessage(error: unknown): string {
  const e = error as { code?: number; message?: string; shortMessage?: string; cause?: unknown };
  if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return 'Request declined in your wallet. You can try again.';
  if (error instanceof BaseError) {
    const reverted = error.walk(x => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name && messages[name]) return messages[name];
      return `The contract rejected this action${name ? ` (${name})` : ''}. Refresh state and try again.`;
    }
    const rejected = error.walk(x => (x as { code?: number }).code === 4001);
    if ((rejected as { code?: number } | null)?.code === 4001) return 'Request declined in your wallet. You can try again.';
  }
  if (/insufficient funds/i.test(e?.message ?? '')) return 'Your wallet needs enough ETH to pay network fees.';
  // Deliberate application errors contain no calldata, RPC URLs or low-level stack traces.
  if (error instanceof AppError) return error.message;
  return 'Unable to complete this request. Check your wallet and connection, then try again.';
}
export class AppError extends Error {}
export function addressIssue(input: string, account?: Address): string | undefined {
  if (!isAddress(input, { strict: true })) return 'Enter a valid Ethereum address.';
  if (sameAddress(input, zeroAddress)) return 'Choose a nonzero worker address.';
  if (sameAddress(input, account)) return 'You cannot hand the job to yourself.';
  return undefined;
}
export async function readGame(client: PublicClient, config: RuntimeConfig, wallet?: Address): Promise<GameSnapshot> {
  const block = await client.getBlock();
  const blockNumber = block.number;
  const job = config.contracts.JobZero;
  const token = config.contracts.LaunchToken;
  const read = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: job.address, abi: job.abi, functionName, args, blockNumber });
  const names = ['currentRun', 'isOpen', 'owner', 'token', 'totalBurned', 'biggestBounty', 'mostHandoffs', 'longestRun', 'OPEN_FEE', 'ONLINE_FEE', 'handoffFee'];
  const values = await Promise.all(names.map(name => read(name)));
  const [currentRun, isOpen, owner, configuredToken, totalBurned, biggestBounty, mostHandoffs, longestRun, openFee, onlineFee, handoffFee] = values as [bigint, boolean, Address, Address, bigint, bigint, bigint, readonly [bigint,bigint], bigint, bigint, bigint];
  const [decimals, symbol, run, queueLength, queue, attempts] = await Promise.all([
    client.readContract({ ...token, functionName: 'decimals', blockNumber }),
    client.readContract({ ...token, functionName: 'symbol', blockNumber }),
    currentRun ? read('runs', [currentRun]) : undefined,
    currentRun ? read('queueLength', [currentRun]) : 0n,
    currentRun ? read('getQueue', [currentRun, 0n, PAGE_SIZE]) : [],
    currentRun ? read('getAttempts', [currentRun, 0n, PAGE_SIZE]) : [],
  ]);
  let personal = {};
  if (wallet) {
    const [balance, allowance, hasHeld, joined, online, stats] = await Promise.all([
      client.readContract({ ...token, functionName: 'balanceOf', args: [wallet], blockNumber }),
      client.readContract({ ...token, functionName: 'allowance', args: [wallet, job.address], blockNumber }),
      read('hasHeld', [currentRun, wallet]), read('hasJoinedQueue', [currentRun, wallet]), read('isOnline', [currentRun, wallet]), read('workerStats', [wallet]),
    ]);
    personal = { wallet, balance, allowance, hasHeld, joined, online, stats };
  }
  return { block: blockNumber, timestamp: block.timestamp, receivedAt: Date.now(), currentRun, isOpen, owner: getAddress(owner), token: getAddress(configuredToken), totalBurned, biggestBounty, mostHandoffs, longestRun, openFee, onlineFee, handoffFee, decimals: Number(decimals), symbol: String(symbol), run: run as Run | undefined, queueLength: queueLength as bigint, queue: queue as QueueEntry[], attempts: attempts as Attempt[], ...personal };
}
export async function readHistory(client: PublicClient, config: RuntimeConfig, lastId: bigint, blockNumber: bigint, wallet?: Address): Promise<RunHistory[]> {
  const job = config.contracts.JobZero;
  const ids: bigint[] = [];
  for (let id = lastId; id > 0n && ids.length < Number(PAGE_SIZE); id--) ids.push(id);
  return Promise.all(ids.map(async id => {
    const [run, claimable, claimed] = await Promise.all([
      client.readContract({ ...job, functionName: 'runs', args: [id], blockNumber }),
      wallet ? client.readContract({ ...job, functionName: 'claimable', args: [id, wallet], blockNumber }) : undefined,
      wallet ? client.readContract({ ...job, functionName: 'claimed', args: [id, wallet], blockNumber }) : undefined,
    ]);
    return { id, run: run as Run, claimable: claimable as bigint | undefined, claimed: claimed as boolean | undefined };
  }));
}
