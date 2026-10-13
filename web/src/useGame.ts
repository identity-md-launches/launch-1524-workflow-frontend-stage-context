import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { zeroAddress, type Address, type Hash, type PublicClient, type WalletClient } from 'viem';
import type { RuntimeConfig } from './config';
import { AppError, errorMessage, readGame, sameAddress, type GameSnapshot } from './game';

export function useGame(client: PublicClient, config: RuntimeConfig, account?: Address) {
  const context = useMemo(() => ({ client, config, account }), [client, config, account]);
  const activeContext = useRef<typeof context | undefined>(undefined);
  const [snapshotContext, setSnapshotContext] = useState<typeof context>();
  const [snapshot, setSnapshot] = useState<GameSnapshot>();
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inFlight = useRef<{ context: typeof context; promise: Promise<void> } | undefined>(undefined);
  const lastRead = useRef<GameSnapshot | undefined>(undefined);
  const needsVerification = useRef(true);
  const verify = useCallback(async () => {
    if (await client.getChainId() !== config.manifest.chainId) throw new AppError('The RPC returned a different chain. Transactions remain disabled.');
    const codes = await Promise.all(config.manifest.contracts.map(contract => client.getBytecode({ address: contract.address })));
    if (codes.some(code => !code || code === '0x')) throw new AppError('A deployed contract has no code on this chain. Transactions remain disabled.');
  }, [client, config]);
  const refresh = useCallback(async (force = true) => {
    if (activeContext.current !== context) return;
    // A receipt-triggered refresh must read a new block after the existing poll.
    // Polls coalesce; explicit refreshes queue behind them instead of disappearing.
    while (inFlight.current?.context === context) {
      const previous = inFlight.current.promise;
      await previous;
      if (activeContext.current !== context || !force) return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (needsVerification.current) await verify();
      const latest = force ? undefined : await client.getBlockNumber({ cacheTime: 0 });
      const walletMatches = account ? sameAddress(account, lastRead.current?.wallet) : !lastRead.current?.wallet;
      if (latest && latest === lastRead.current?.block && Date.now() - lastRead.current.receivedAt < 20_000 && walletMatches && !needsVerification.current) return undefined;
      return readGame(client, config, account);
    };
    const promise = (async () => {
      try {
        const data = await Promise.race([
          load(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new AppError('Live reads timed out. Transactions remain disabled until a fresh read succeeds.')), 30_000); }),
        ]);
        if (activeContext.current !== context || !data) return;
        if (data.decimals !== 18 || data.symbol !== 'TEYO') throw new AppError('The deployed token metadata does not match TEYO. Transactions remain disabled.');
        if (lastRead.current && data.block < lastRead.current.block) throw new AppError('The RPC returned an older block. Transactions remain disabled until current state is available.');
        lastRead.current = data; needsVerification.current = false;
        setSnapshot(data); setSnapshotContext(context); setVerified(true); setError('');
      } catch (e) {
        if (activeContext.current === context) {
          needsVerification.current = true; setVerified(false);
          setError(e instanceof AppError ? e.message : 'Live reads are unavailable. Retry, or connect a wallet on the configured network for a fallback RPC.');
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        if (activeContext.current === context) setLoading(false);
      }
    })();
    const request = { context, promise };
    inFlight.current = request;
    await promise;
    // Old wallet requests must never unlock a newer wallet's request.
    if (inFlight.current === request) inFlight.current = undefined;
  }, [client, config, account, context, verify]);
  useEffect(() => {
    activeContext.current = context; lastRead.current = undefined; needsVerification.current = true;
    setSnapshot(undefined); setSnapshotContext(undefined); setVerified(false); setLoading(true); setError('');
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(false); }, 5000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      if (activeContext.current === context) activeContext.current = undefined;
      window.clearInterval(timer); window.removeEventListener('focus', onFocus);
    };
  }, [context, refresh]);
  const current = snapshotContext === context;
  return { snapshot: current ? snapshot : undefined, verified: current && verified, loading: activeContext.current !== context || loading, error, refresh };
}

export type TxPhase = 'simulating' | 'wallet' | 'confirming' | 'success' | 'error' | 'unconfirmed';
export interface TransactionState { key: string; label: string; phase: TxPhase; message: string; hash?: Hash }
export interface WriteAction { key: string; label: string; contract?: 'JobZero' | 'LaunchToken'; functionName: string; args?: readonly unknown[]; expectedRun?: bigint; paidFee?: bigint; feeFunction?: string }
class ConfirmedTransactionError extends AppError {
  constructor(message: string, readonly hash: Hash) { super(message); }
}
export function transactionReceiptFailure(status: 'success' | 'reverted', replacement?: 'cancelled' | 'replaced' | 'repriced'): string | undefined {
  if (replacement === 'cancelled') return 'The transaction was cancelled in your wallet. The requested action was not completed.';
  if (replacement === 'replaced') return 'Your wallet replaced this transaction with a different action. Review the explorer and live state before continuing.';
  if (status !== 'success') return 'The transaction reverted on chain. Refresh state before retrying.';
  return undefined;
}
export function useTransactions({ config, client, wallet, account, canTransact, refresh, busy, setBusy }: {
  config: RuntimeConfig; client: PublicClient; wallet?: WalletClient; account?: Address; canTransact: boolean;
  refresh: () => Promise<void>; busy: boolean; setBusy: (busy: boolean) => void;
}) {
  const [tx, setTx] = useState<TransactionState>();
  const lock = useRef(false);
  const receiptCheckLock = useRef(false);
  const pending = useRef<{ hash: Hash; replacementReason?: 'cancelled' | 'replaced' | 'repriced' } | undefined>(undefined);
  const finishReceipt = async (hash: Hash, initial: TransactionState) => {
    // Preserve observed replacements across RPC failures and manual receipt checks.
    const tracked = pending.current ?? { hash };
    pending.current = tracked;
    const receipt = await client.waitForTransactionReceipt({ hash: tracked.hash, confirmations: 1, timeout: 120_000, pollingInterval: 1500,
      onReplaced: replacement => {
        tracked.hash = replacement.transaction.hash;
        // Repricing a changed/cancelled transaction does not restore the original action.
        if (replacement.reason !== 'repriced' || !tracked.replacementReason) tracked.replacementReason = replacement.reason;
        setTx({ ...initial, phase: 'confirming', message: tracked.replacementReason === 'repriced' ? 'Transaction fee updated. Checking confirmation…' : 'Transaction changed in your wallet. Checking its final result…', hash: tracked.hash });
      },
    });
    tracked.hash = receipt.transactionHash;
    await refresh();
    const failure = transactionReceiptFailure(receipt.status, tracked.replacementReason);
    if (failure) throw new ConfirmedTransactionError(failure, receipt.transactionHash);
    setTx({ ...initial, phase: 'success', message: `${initial.label} confirmed. Review live state before your next action.`, hash: receipt.transactionHash });
  };
  const checkReceipt = async () => {
    if (receiptCheckLock.current || !tx?.hash || tx.phase !== 'unconfirmed') return;
    receiptCheckLock.current = true;
    const initial = tx;
    setTx({ ...tx, phase: 'confirming', message: 'Checking the submitted transaction…' });
    try { await finishReceipt(tx.hash, initial); lock.current = false; setBusy(false); }
    catch (e) {
      if (e instanceof AppError) { setTx({ ...initial, phase: 'error', hash: e instanceof ConfirmedTransactionError ? e.hash : pending.current?.hash ?? initial.hash, message: errorMessage(e) }); lock.current = false; setBusy(false); }
      else setTx({ ...initial, phase: 'unconfirmed', hash: pending.current?.hash ?? initial.hash, message: 'Confirmation is still unavailable. Check the explorer before doing anything else.' });
    } finally { receiptCheckLock.current = false; }
  };
  const submit = async (action: WriteAction) => {
    if (lock.current || busy) return;
    if (!canTransact || !wallet || !account) { setTx({ key: action.key, label: action.label, phase: 'error', message: 'Connect on the configured network and refresh verified live state before signing.' }); return; }
    lock.current = true; setBusy(true);
    pending.current = undefined;
    const initial: TransactionState = { key: action.key, label: action.label, phase: 'simulating', message: `Checking ${action.label.toLowerCase()}…` };
    setTx(initial);
    let submitted: Hash | undefined;
    try {
      if (await wallet.getChainId() !== config.manifest.chainId) throw new AppError(`Switch your wallet to ${config.network.name} before signing.`);
      const activeAccounts = await wallet.getAddresses();
      if (!sameAddress(activeAccounts[0], account)) throw new AppError('Your wallet account changed. Reconnect before signing.');
      if (await client.getChainId() !== config.manifest.chainId) throw new AppError('RPC chain verification failed. Refresh before signing.');
      const job = config.contracts.JobZero;
      if (action.expectedRun !== undefined) {
        const current = await client.readContract({ ...job, functionName: 'currentRun' });
        if (current !== action.expectedRun) { await refresh(); throw new AppError('The run changed. Review the updated state before continuing.'); }
      }
      if (action.paidFee !== undefined && action.feeFunction) {
        const fee = await client.readContract({ ...job, functionName: action.feeFunction });
        if (fee !== action.paidFee) { await refresh(); throw new AppError('The fee changed. Review the updated amount before continuing.'); }
      }
      const target = config.contracts[action.contract ?? 'JobZero'];
      const { request } = await client.simulateContract({ address: target.address, abi: target.abi, functionName: action.functionName, args: action.args ?? [], account, chain: config.chain });
      if (await wallet.getChainId() !== config.manifest.chainId || !sameAddress((await wallet.getAddresses())[0], account)) throw new AppError('The wallet changed during verification. Review and try again.');
      setTx({ ...initial, phase: 'wallet', message: `Confirm ${action.label.toLowerCase()} in your wallet.` });
      submitted = await wallet.writeContract(request);
      pending.current = { hash: submitted };
      setTx({ ...initial, phase: 'confirming', message: 'Transaction submitted. Waiting for a block confirmation…', hash: submitted });
      await finishReceipt(submitted, initial);
      lock.current = false; setBusy(false);
    } catch (e) {
      if (submitted && !(e instanceof AppError)) {
        setTx({ ...initial, phase: 'unconfirmed', hash: pending.current?.hash ?? submitted, message: 'Confirmation is unavailable. This transaction may still be pending. Check its status before retrying.' });
      } else {
        setTx({ ...initial, phase: 'error', hash: e instanceof ConfirmedTransactionError ? e.hash : pending.current?.hash ?? submitted, message: errorMessage(e) });
        lock.current = false; setBusy(false);
        void refresh();
      }
    }
  };
  return { tx, submit, checkReceipt };
}
export function tokenConfigured(snapshot: GameSnapshot | undefined, config: RuntimeConfig) {
  return Boolean(snapshot && !sameAddress(snapshot.token, zeroAddress) && sameAddress(snapshot.token, config.contracts.LaunchToken.address));
}
