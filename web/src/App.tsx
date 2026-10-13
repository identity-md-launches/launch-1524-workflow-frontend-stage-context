import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatUnits, getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { loadConfig, type RuntimeConfig } from './config';
import { addressIssue, AppError, countdown, dateTime, errorMessage, PAGE_SIZE, readHistory, sameAddress, shortAddress, tokens, type Attempt, type GameSnapshot, type QueueEntry, type RunHistory } from './game';
import { useWallet } from './wallet';
import { tokenConfigured, useGame, useTransactions, type WriteAction } from './useGame';
import { SwapPanel } from './SwapPanel';
import { parseSwapAmount } from './swap';

function Mark() {
  return <svg aria-hidden="true" viewBox="0 0 28 28" width="28" height="28"><path fill="currentColor" d="M2 3h6v22H2zM11 3h6v8h-6zM11 14h6v11h-6zM20 3h6v22h-6z"/><path fill="var(--danger)" d="M0 11h28v3H0z"/></svg>;
}
function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return <section id={id} className="panel" aria-labelledby={`${id}-heading`}><div className="section-header"><h2 id={`${id}-heading`}>{title}</h2>{aside}</div>{children}</section>;
}
function AddressView({ address, config, full = false }: { address: Address; config: RuntimeConfig; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const checked = getAddress(address);
  async function copy() {
    try { await navigator.clipboard.writeText(checked); setCopied(true); setCopyError(false); window.setTimeout(() => setCopied(false), 2000); }
    catch { setCopyError(true); }
  }
  return <span className={`address ${full ? 'address-full' : ''}`}><a href={`${config.network.explorer}/address/${checked}`} target="_blank" rel="noreferrer" title={checked} aria-label={`View ${checked} on ${config.network.name} explorer`}>{full ? checked : shortAddress(checked)}<span aria-hidden="true"> ↗</span></a><button type="button" className="copy-button" onClick={() => void copy()} aria-label={`Copy address ${checked}`} title="Copy full address">{copied ? '✓' : '⧉'}</button>{copyError && <small className="error">Copy unavailable. Open the explorer to copy.</small>}</span>;
}
function TokenAmount({ value, decimals = 18, className = '' }: { value?: bigint; decimals?: number; className?: string }) {
  return <span className={`token-amount ${className}`} title={value === undefined ? undefined : `${formatUnits(value, decimals)} TEYO`}>{tokens(value, decimals, decimals)} <span className="unit">TEYO</span></span>;
}
function LoadingApp({ error, retry }: { error?: string; retry: () => void }) {
  return <><header className="site-header"><a className="brand" href="#"><Mark/><span>imd<span className="muted"> / explorer</span></span></a></header><main className="container"><h1>JOB #0</h1><p>Every job gets finished. Except this one.</p><section className="panel"><h2>{error ? 'Deployment unavailable' : 'Verifying deployment…'}</h2><p role={error ? 'alert' : 'status'}>{error || 'Reading the deployment manifest and checking the contract ABIs.'}</p>{error && <button className="button" onClick={retry}>Retry configuration</button>}</section></main></>;
}
export default function App() {
  const [config, setConfig] = useState<RuntimeConfig>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setError('');
    void loadConfig().then(c => { if (active) setConfig(c); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Unable to load the deployment configuration.'); });
    return () => { active = false; };
  }, [attempt]);
  return config ? <Explorer config={config}/> : <LoadingApp error={error} retry={() => setAttempt(v => v + 1)}/>;
}

function Explorer({ config }: { config: RuntimeConfig }) {
  const wallet = useWallet(config);
  const { snapshot: state, verified, loading, error: readError, refresh } = useGame(wallet.publicClient, config, wallet.account);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [motion, setMotion] = useState(true);
  const [recipient, setRecipient] = useState('');
  const [recipientChecked, setRecipientChecked] = useState<Address>();
  const [recipientError, setRecipientError] = useState('');
  const [checkingRecipient, setCheckingRecipient] = useState(false);
  const recipientInput = useRef<HTMLInputElement>(null);
  const recipientVersion = useRef(0);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const queueView = useRef<{ block: bigint; run: bigint; total: bigint; expanded: boolean } | undefined>(undefined);
  const attemptView = useRef<{ block: bigint; run: bigint; total: bigint; expanded: boolean } | undefined>(undefined);
  const historyVersion = useRef(0);
  const claimVersion = useRef(0);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [paging, setPaging] = useState('');
  const [pageError, setPageError] = useState('');
  const [history, setHistory] = useState<RunHistory[]>([]);
  const [historyBlock, setHistoryBlock] = useState<bigint>();
  const [historyWallet, setHistoryWallet] = useState<Address>();
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [claimId, setClaimId] = useState('');
  const [foundClaim, setFoundClaim] = useState<RunHistory>();
  const [claimError, setClaimError] = useState('');
  const [checkingClaim, setCheckingClaim] = useState(false);
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferError, setTransferError] = useState('');

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const rightChain = wallet.chainId === config.manifest.chainId;
  const fresh = Boolean(state && now - state.receivedAt < 30_000);
  const matchingWallet = state?.wallet === wallet.account;
  const canTransact = Boolean(wallet.account && rightChain && verified && fresh && matchingWallet);
  const configured = tokenConfigured(state, config);
  const liveState = verified && fresh ? state : undefined;
  const isWorker = Boolean(state?.isOpen && sameAddress(wallet.account, state.run?.worker));
  const chainNow = state ? Number(state.timestamp) + Math.max(0, Math.floor((now - state.receivedAt) / 1000)) : 0;
  const timeLeft = state?.isOpen && state.run ? Math.max(0, Number(state.run.deadline) - chainNow) : 0;
  const expired = Boolean(state?.isOpen && timeLeft === 0);
  const blockedReason = !wallet.account ? 'Connect a wallet to continue.' : !rightChain ? `Switch to ${config.network.name} to continue.` : !verified || !fresh || !matchingWallet ? 'Verified live state is unavailable. Refresh before signing.' : undefined;
  const { tx, submit, checkReceipt } = useTransactions({ config, client: wallet.publicClient, wallet: wallet.walletClient, account: wallet.account, canTransact, refresh: async () => { await refresh(); setHistoryRefresh(v => v + 1); setFoundClaim(undefined); }, busy, setBusy });
  const activePhase = tx && ['simulating', 'wallet', 'confirming', 'unconfirmed'].includes(tx.phase);
  useEffect(() => {
    if (!state) { setQueue([]); setAttempts([]); queueView.current = undefined; attemptView.current = undefined; return; }
    if (!queueView.current?.expanded || queueView.current.run !== state.currentRun) {
      queueView.current = { block: state.block, run: state.currentRun, total: state.queueLength, expanded: false };
      setQueue(state.queue);
    }
    if (!attemptView.current?.expanded || attemptView.current.run !== state.currentRun) {
      attemptView.current = { block: state.block, run: state.currentRun, total: state.run?.attempts ?? 0n, expanded: false };
      setAttempts(state.attempts);
    }
    setPageError('');
  }, [state]);
  useEffect(() => { recipientVersion.current++; setCheckingRecipient(false); }, [state?.currentRun, state?.run?.worker, wallet.account]);
  useEffect(() => { setRecipientChecked(undefined); setRecipientError(''); }, [recipient, state?.currentRun, state?.run?.worker, wallet.account]);
  useEffect(() => { claimVersion.current++; setFoundClaim(undefined); setClaimError(''); setCheckingClaim(false); }, [wallet.account, claimId]);
  const latestHistory = state?.currentRun;
  useEffect(() => {
    let cancelled = false;
    historyVersion.current++;
    setHistory([]); setHistoryWallet(undefined); setHistoryBlock(undefined);
    if (!state || !verified) { setHistoryLoading(false); return; }
    setHistoryLoading(true); setHistoryError('');
    const block = state.block;
    void readHistory(wallet.publicClient, config, state.currentRun, block, wallet.account).then(rows => {
      if (!cancelled) { setHistory(rows); setHistoryWallet(wallet.account); setHistoryBlock(block); }
    }).catch(() => { if (!cancelled) { setHistory([]); setHistoryError('Run history could not be loaded. Retry to find older bounties and failed workers.'); } }).finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  // History is refreshed on run transitions, settlement, account changes or explicit retry, not every block.
  }, [latestHistory, state?.isOpen, wallet.account, wallet.publicClient, config, verified, historyRefresh]);
  async function pageList(kind: 'queue' | 'attempts') {
    if (!state || paging) return;
    setPaging(kind); setPageError('');
    const view = kind === 'queue' ? queueView.current : attemptView.current;
    if (!view) { setPaging(''); return; }
    view.expanded = true;
    try {
      const list = kind === 'queue' ? queue : attempts;
      const result = await wallet.publicClient.readContract({ ...config.contracts.JobZero, functionName: kind === 'queue' ? 'getQueue' : 'getAttempts', args: [view.run, BigInt(list.length), PAGE_SIZE], blockNumber: view.block });
      if ((kind === 'queue' ? queueView.current : attemptView.current) !== view) return;
      if (kind === 'queue') setQueue([...queue, ...(result as QueueEntry[])]); else setAttempts([...attempts, ...(result as Attempt[])]);
    } catch { if ((kind === 'queue' ? queueView.current : attemptView.current) === view) setPageError('This page could not be read. Refresh and try again.'); }
    finally { setPaging(''); }
  }
  async function olderRuns() {
    if (historyLoading || !history.length || !historyBlock) return;
    setHistoryLoading(true); setHistoryError('');
    const version = historyVersion.current;
    try { const rows = await readHistory(wallet.publicClient, config, history[history.length - 1].id - 1n, historyBlock, wallet.account); if (version === historyVersion.current) setHistory(old => [...old, ...rows]); }
    catch { if (version === historyVersion.current) setHistoryError('Older runs could not be read. Try loading them again.'); }
    finally { if (version === historyVersion.current) setHistoryLoading(false); }
  }
  async function checkRecipient(value = recipient) {
    const version = ++recipientVersion.current;
    setRecipientError(''); setRecipientChecked(undefined);
    const input = value.trim();
    const issue = addressIssue(input, wallet.account);
    if (issue) { setRecipientError(issue); recipientInput.current?.focus(); return undefined; }
    if (!state || !canTransact || !isWorker || expired) { setRecipientError('Connect as the current worker before the deadline.'); return undefined; }
    setCheckingRecipient(true);
    try {
      const address = getAddress(input);
      const held = await wallet.publicClient.readContract({ ...config.contracts.JobZero, functionName: 'hasHeld', args: [state.currentRun, address] });
      if (version !== recipientVersion.current) return undefined;
      if (held) throw new AppError('This address already held JOB #0 in this run. Choose a new worker.');
      setRecipientChecked(address); return address;
    } catch (e) { if (version === recipientVersion.current) setRecipientError(errorMessage(e)); return undefined; }
    finally { if (version === recipientVersion.current) setCheckingRecipient(false); }
  }
  function paidAction(kind: 'open' | 'goOnline' | 'handoff', cost: bigint, label: string, args: readonly unknown[] = []): WriteAction {
    const approval = (state?.allowance ?? 0n) < cost;
    return { key: kind, label: approval ? 'Approve TEYO' : label, contract: approval ? 'LaunchToken' : 'JobZero', functionName: approval ? 'approve' : kind, args: approval ? [config.contracts.JobZero.address, cost] : args, expectedRun: state?.currentRun, paidFee: cost, feeFunction: kind === 'open' ? 'OPEN_FEE' : kind === 'goOnline' ? 'ONLINE_FEE' : 'handoffFee' };
  }
  function paidButton(kind: 'open' | 'goOnline' | 'handoff', cost: bigint, label: string, disabled = false, to?: Address) {
    const approve = (state?.allowance ?? 0n) < cost;
    const pending = activePhase && tx.key === kind;
    const lowBalance = matchingWallet && state?.balance !== undefined && state.balance < cost;
    return <div className="action-control"><button className="button button-primary" data-testid={`action-${kind}`} disabled={!canTransact || !configured || busy || disabled || lowBalance || checkingRecipient} onClick={() => {
      if (kind === 'handoff') {
        void (async () => { const valid = await checkRecipient(to ?? recipient); if (valid) await submit(paidAction(kind, cost, label, [valid])); })();
      } else void submit(paidAction(kind, cost, label));
    }}>{pending ? `${tx.label} · ${tx.phase === 'wallet' ? 'Confirm in wallet…' : 'Pending…'}` : approve ? 'Approve TEYO' : label}<span aria-hidden="true"> ↗</span></button>{lowBalance && <small className="error">You need {tokens(cost - state!.balance!, state?.decimals)} more TEYO. <a href="#trade">Get TEYO</a>.</small>}{approve && !pending && <small className="muted">Step 1: allow JobZero to spend this exact fee. Step 2: {label.toLowerCase()}.</small>}</div>;
  }
  const simpleAction = (key: string, label: string, functionName: string, args: readonly unknown[] = [], disabled = false) => <button className="button" disabled={!canTransact || !configured || busy || disabled} onClick={() => void submit({ key, label, functionName, args, expectedRun: functionName === 'claim' ? undefined : state?.currentRun })}>{activePhase && tx.key === key ? `${label} · Pending…` : label}</button>;
  async function checkClaim() {
    setClaimError(''); setFoundClaim(undefined);
    if (!wallet.account || !state) { setClaimError('Connect a wallet and load live state first.'); return; }
    if (!/^[1-9]\d*$/.test(claimId.trim()) || BigInt(claimId) > state.currentRun) { setClaimError('Enter an existing run number, starting at 1.'); return; }
    setCheckingClaim(true);
    const version = ++claimVersion.current;
    try {
      const job = config.contracts.JobZero; const id = BigInt(claimId); const blockNumber = state.block;
      const [run, claimable, claimed] = await Promise.all([
        wallet.publicClient.readContract({ ...job, functionName: 'runs', args: [id], blockNumber }),
        wallet.publicClient.readContract({ ...job, functionName: 'claimable', args: [id, wallet.account], blockNumber }),
        wallet.publicClient.readContract({ ...job, functionName: 'claimed', args: [id, wallet.account], blockNumber }),
      ]);
      if (version === claimVersion.current) setFoundClaim({ id, run: run as RunHistory['run'], claimable: claimable as bigint, claimed: claimed as boolean });
    }
    catch { if (version === claimVersion.current) setClaimError('This bounty could not be checked. Retry after refreshing state.'); }
    finally { if (version === claimVersion.current) setCheckingClaim(false); }
  }
  async function transfer() {
    setTransferError('');
    try {
      if (!isAddress(transferTo.trim()) || sameAddress(transferTo.trim(), zeroAddress)) throw new AppError('Enter a valid, nonzero recipient address.');
      let amount: bigint;
      try { amount = parseSwapAmount(transferAmount, state?.decimals ?? 18); }
      catch (e) { throw new AppError(e instanceof Error ? e.message : 'Enter a positive TEYO amount.'); }
      if (!state?.balance || amount > state.balance) throw new AppError('Enter an amount within your TEYO balance.');
      await submit({ key: 'transfer', label: 'Send TEYO', contract: 'LaunchToken', functionName: 'transfer', args: [getAddress(transferTo.trim()), amount] });
    } catch (e) { setTransferError(errorMessage(e)); }
  }
  const walletGate = !wallet.account ? <button className="button button-primary" onClick={() => void wallet.connect()} disabled={wallet.connecting}>{wallet.connecting ? 'Connecting…' : 'Connect to play'}<span aria-hidden="true"> ↗</span></button> : !rightChain ? <button className="button button-primary" onClick={() => void wallet.switchChain()} disabled={wallet.connecting}>{wallet.connecting ? 'Switching network…' : `Switch to ${config.network.name}`}</button> : null;
  const status = loading ? 'Loading' : !verified || !fresh ? 'Reads unavailable' : !configured ? 'Awaiting setup' : state?.isOpen ? expired ? 'Deadline passed' : 'Running' : 'Ready to open';
  const claims = (historyWallet === wallet.account ? history : []).filter(row => row.run.closed && (row.claimable ?? 0n) > 0n);
  const failed = history.filter(row => row.run.closed);

  return <div className={motion ? '' : 'motion-paused'}>
    <a className="skip-link" href="#main">Skip to explorer</a>
    <header className="site-header"><a className="brand" href="#main" aria-label="IMD JOB #0 explorer"><Mark/><span>imd<span className="muted"> / explorer</span></span></a><div className="header-actions"><a className="help-link" href="#docs">How to play</a>{wallet.account ? <details className="wallet-menu"><summary>{shortAddress(wallet.account)}<span aria-hidden="true"> ▾</span></summary><div className="wallet-menu-content"><span className="muted">Connected wallet</span><AddressView address={wallet.account} config={config} full/><span>{rightChain ? config.network.name : 'Wrong network'}</span><TokenAmount value={matchingWallet ? state?.balance : undefined} decimals={state?.decimals}/><button className="button" disabled={busy} onClick={wallet.disconnect}>Disconnect</button></div></details> : <button className="button wallet-button" onClick={() => void wallet.connect()} disabled={wallet.connecting}>{wallet.connecting ? 'Connecting…' : 'Connect wallet'}</button>}</div></header>
    <main id="main" className="container">
      <div className="hero"><div><h1>JOB #0<span className="cursor" aria-hidden="true">_</span></h1><p>Every job gets finished.<br className="mobile-break"/> Except this one.</p></div><div className="failure-stamp" aria-label="Story status: verification failed">Verification<br/>failed<span aria-hidden="true"> ×</span></div></div>
      <nav className="section-nav" aria-label="Explorer sections"><a href="#job">Job</a><a href="#queue">Queue</a><a href="#attempts">Attempts</a><a href="#bounties">Bounties</a><a href="#trade">Trade TEYO</a></nav>
      {wallet.error && <div className="notice error" role="alert">{wallet.error}</div>}
      {wallet.providers.length > 1 && !wallet.account && <label className="wallet-select">Choose wallet<select disabled={wallet.connecting} value={wallet.providers.find(p => p.provider === wallet.provider)?.id ?? ''} onChange={e => wallet.selectProvider(e.target.value)}>{wallet.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <section id="job" className="job-panel" aria-labelledby="job-heading">
        <div className="job-heading"><h2 id="job-heading">Job record <span className="muted">/ {state?.currentRun ? `run ${state.currentRun}` : 'unassigned'}</span></h2><span className={`status-badge ${expired ? 'error' : ''}`} data-testid="job-status"><span aria-hidden="true" className={verified && fresh ? 'status-dot' : 'status-dot muted-dot'}/>{status}</span></div>
        <div className="job-body"><div className="clock-block"><span className="label">Time to hand off</span><div className={`countdown ${expired ? 'error' : ''}`} aria-label={state?.isOpen ? `${countdown(timeLeft)} remaining, estimated from the latest block` : 'No active deadline'}>{state?.isOpen ? countdown(timeLeft) : '--:--:--'}</div><div className="current-worker"><span className="label">Current worker</span>{state?.isOpen && state.run ? <AddressView address={state.run.worker} config={config}/> : <span className="muted">{loading || readError ? 'Waiting for live state' : 'Nobody holds it yet'}</span>}</div></div><dl className="job-metrics"><div><dt>Bounty</dt><dd><TokenAmount value={state?.run?.bounty ?? (state ? 0n : undefined)} decimals={state?.decimals}/></dd></div><div><dt>Attempts</dt><dd>{state ? (state.run?.attempts ?? 0n).toLocaleString() : '—'}</dd></div><div><dt>Next handoff</dt><dd><TokenAmount value={state?.handoffFee} decimals={state?.decimals}/></dd></div><div><dt>Fee growth</dt><dd>+3% <span className="unit">/ handoff</span></dd></div></dl></div>
        <div className="main-action" data-testid="main-action">
          {walletGate && state && verified && !configured && <p className="muted">Gameplay awaits the owner’s one-time TEYO setup.</p>}
          {walletGate || (!state || !verified || !fresh || !matchingWallet ? <><p className="muted">{loading ? 'Checking chain state before enabling actions…' : 'Live reads unavailable. Refresh to safely continue.'}</p><button className="button" onClick={() => void refresh()} disabled={loading}>Refresh live state</button></> : !configured ? <p className="notice">{sameAddress(state.token, zeroAddress) ? 'Gameplay is not configured yet. The owner must set TEYO once.' : 'The configured game token does not match this deployment. Gameplay is disabled.'}</p> : !state.isOpen ? <><p>Take the first shift. Opening adds <TokenAmount value={state.openFee} decimals={state.decimals}/> to the bounty.</p>{paidButton('open', state.openFee, 'Open JOB #0')}</> : expired ? <><p className="error">Time is up. Close the run to mark the last worker failed and release the bounty.</p>{simpleAction('timeout', 'Force timeout', 'timeout')}</> : isWorker ? <div className="assignment"><h3>JOB #0 IS ASSIGNED TO YOU</h3><p>Pay <TokenAmount value={state.handoffFee} decimals={state.decimals}/> to pass it. Half is burned; half grows the bounty.</p><label htmlFor="recipient">Next worker’s Ethereum address</label><div className="field-action"><input id="recipient" ref={recipientInput} name="recipient" placeholder="Paste a new worker’s address" autoComplete="off" spellCheck={false} value={recipient} aria-invalid={Boolean(recipientError)} aria-describedby="recipient-note" onChange={e => { recipientVersion.current++; setCheckingRecipient(false); setRecipient(e.target.value); }}/><button className="button" disabled={!canTransact || busy || checkingRecipient} onClick={() => void checkRecipient()}>{checkingRecipient ? 'Checking…' : 'Check worker'}</button></div><small id="recipient-note" className={recipientError ? 'error' : 'muted'} role={recipientError ? 'alert' : undefined}>{recipientError || (recipientChecked ? `Eligible: ${recipientChecked}` : 'A new worker for this run. Queue membership is optional.')}</small>{paidButton('handoff', state.handoffFee, 'Hand off JOB #0')}<a className="text-link share-link" target="_blank" rel="noreferrer" href={`https://x.com/intent/post?text=${encodeURIComponent(`JOB #0 is assigned to me. ${countdown(timeLeft)} left. Who takes it next? ${window.location.href.split('#')[0]}`)}`}>Share on X ↗</a></div> : state.online ? <><p>You are online. A worker can hand JOB #0 to you.</p>{simpleAction('goOffline', 'Go offline', 'goOffline')}<small className="muted">Leaving is final for this run. The queue fee is not refunded.</small></> : state.hasHeld || state.joined ? <><p>{state.hasHeld ? 'You have already held this run. Follow the countdown and check your bounty after timeout.' : 'You already used this run’s queue entry. You can still receive the job directly if you have never held it.'}</p><a className="button" href="#bounties">View bounties</a></> : <><p>Ready for the job? Join the queue for <TokenAmount value={state.onlineFee} decimals={state.decimals}/>, burned.</p>{paidButton('goOnline', state.onlineFee, 'Go online')}<small className="muted">One queue entry per run. Receiving the job starts your 24-hour clock.</small></>)}
        </div>
        <div className="record-bottom"><span>{state && verified ? `Read at block ${state.block.toLocaleString()}` : 'Waiting for verified chain state'}</span><button className="text-button" disabled={loading} onClick={() => void refresh()}>{loading ? 'Reading…' : 'Refresh ↻'}</button></div>
      </section>
      {readError && <p className="notice error" role="alert">{readError}</p>}
      {tx && <section className={`transaction notice ${tx.phase === 'error' || tx.phase === 'unconfirmed' ? 'error' : ''}`} aria-label="Transaction status"><div role={tx.phase === 'error' ? 'alert' : 'status'}><strong>{tx.label}</strong><p>{tx.message}</p></div>{tx.hash && <a href={`${config.network.explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}{tx.phase === 'unconfirmed' && <button className="button" onClick={() => void checkReceipt()}>Check confirmation</button>}</section>}
      {state && sameAddress(state.token, zeroAddress) && sameAddress(wallet.account, state.owner) && <Section id="setup" title="Owner setup"><p>Set the deployed TEYO address once. This choice is permanent and unlocks gameplay.</p><AddressView address={config.contracts.LaunchToken.address} config={config} full/><label className="checkbox-label"><input type="checkbox" checked={setupConfirmed} onChange={e => setSetupConfirmed(e.target.checked)}/>I understand this token cannot be changed.</label><button className="button button-primary" disabled={!canTransact || busy || !setupConfirmed} onClick={() => void submit({ key: 'setToken', label: 'Set TEYO', functionName: 'setToken', args: [config.contracts.LaunchToken.address] })}>{activePhase && tx.key === 'setToken' ? 'Set TEYO · Pending…' : 'Set TEYO permanently'}</button></Section>}
      <div className="board">
        <Section id="queue" title="Worker queue" aside={<span className="muted">{state?.queueLength.toLocaleString() ?? '—'} online</span>}>
          {!state ? <p className="empty">Live queue data will appear when the connection is available.</p> : queue.length === 0 ? <p className="empty">No workers online{state.isOpen ? '. Join the queue to offer to take the job.' : '. Open a run to start the queue.'}</p> : <ol className="data-list">{queue.map((entry) => <li key={entry.worker}><div><AddressView address={entry.worker} config={config}/><small className="muted">Online since {dateTime(entry.onlineAt)}</small></div>{isWorker && !expired && <button className="button row-action" disabled={!canTransact || busy || checkingRecipient} aria-label={`Hand off to ${entry.worker}`} onClick={() => { setRecipient(entry.worker); document.getElementById('job')?.scrollIntoView({ behavior: 'instant', block: 'start' }); void checkRecipient(entry.worker).then(valid => { if (valid && state) void submit(paidAction('handoff', state.handoffFee, 'Hand off JOB #0', [valid])); }); }}>Hand off ↗</button>}</li>)}</ol>}
          {state && BigInt(queue.length) < (queueView.current?.total ?? state.queueLength) && <button className="button" disabled={Boolean(paging)} onClick={() => void pageList('queue')}>{paging === 'queue' ? 'Loading…' : 'Load more workers'}</button>}
          {queueView.current?.expanded && <div className="list-snapshot"><small className="muted">Queue snapshot at block {queueView.current.block.toString()}.</small><button className="text-button" disabled={Boolean(paging)} onClick={() => { if (state) { queueView.current = { block: state.block, run: state.currentRun, total: state.queueLength, expanded: false }; setQueue(state.queue); } }}>Refresh queue list</button></div>}
          <p className="section-note">Newest first. Joining burns {state ? tokens(state.onlineFee, state.decimals) : '10'} TEYO. One entry per wallet, per run.</p>
        </Section>
        <Section id="attempts" title="Attempt log" aside={<span className="muted">Newest first</span>}>
          {!state ? <p className="empty">Waiting for the current run’s contract records.</p> : attempts.length === 0 ? <p className="empty">No attempts yet. The first worker starts the record.</p> : <ol className="data-list attempts-list">{attempts.map((entry, index) => <li key={`${entry.worker}-${entry.startedAt}`}><span className="attempt-number">{String((attemptView.current?.total ?? state.run?.attempts ?? 0n) - BigInt(index)).padStart(2, '0')}</span><div><AddressView address={entry.worker} config={config}/><small className="muted">{dateTime(entry.startedAt)}</small></div><span className={`attempt-tag ${entry.status === 2 ? 'error' : ''}`}>{entry.status === 1 ? 'Handed off' : entry.status === 2 ? 'Failed' : expired ? 'Overdue' : 'Holding'}</span></li>)}</ol>}
          {state?.run && BigInt(attempts.length) < (attemptView.current?.total ?? state.run.attempts) && <button className="button" disabled={Boolean(paging)} onClick={() => void pageList('attempts')}>{paging === 'attempts' ? 'Loading…' : 'Load more attempts'}</button>}
          {attemptView.current?.expanded && <div className="list-snapshot"><small className="muted">Attempt snapshot at block {attemptView.current.block.toString()}.</small><button className="text-button" disabled={Boolean(paging)} onClick={() => { if (state) { attemptView.current = { block: state.block, run: state.currentRun, total: state.run?.attempts ?? 0n, expanded: false }; setAttempts(state.attempts); } }}>Refresh attempt list</button></div>}
          {state?.run && state.run.openedAt > 0n && <p className="section-note">Run opened {dateTime(state.run.openedAt)}.</p>}
        </Section>
      </div>
      {pageError && <p className="notice error" role="alert">{pageError}</p>}
      <div className="board">
        <Section id="bounties" title="Bounties" aside={<span className="muted">Your share</span>}>
          {!wallet.account ? <p className="empty">Connect your wallet to find TEYO earned in past runs.</p> : historyLoading && !history.length ? <p className="empty" role="status">Checking your shares…</p> : claims.length ? <ul className="data-list">{claims.map(row => <li key={row.id}><div><strong>Run #{row.id.toString()}</strong><TokenAmount value={row.claimable} decimals={state?.decimals}/></div>{simpleAction(`claim-${row.id}`, 'Claim TEYO', 'claim', [row.id])}</li>)}</ul> : <p className="empty">No unclaimed shares in the loaded runs. Earlier workers get equal shares after timeout; the failed worker gets nothing.</p>}
          {wallet.account && <><div className="lookup"><label htmlFor="claim-run">Check a specific run</label><div className="field-action"><input id="claim-run" name="claim-run" inputMode="numeric" value={claimId} onChange={e => setClaimId(e.target.value)} placeholder="Run number" aria-invalid={Boolean(claimError)} aria-describedby="claim-result"/><button className="button" disabled={checkingClaim || !verified} onClick={() => void checkClaim()}>{checkingClaim ? 'Checking…' : 'Check bounty'}</button></div><div id="claim-result" role="status">{claimError && <p className="error">{claimError}</p>}{foundClaim && <p>Run #{foundClaim.id.toString()}: {(foundClaim.claimable ?? 0n) > 0n ? <><TokenAmount value={foundClaim.claimable} decimals={state?.decimals}/>{simpleAction(`claim-${foundClaim.id}`, 'Claim this bounty', 'claim', [foundClaim.id])}</> : foundClaim.claimed ? 'Already claimed by this wallet.' : !foundClaim.run.closed ? 'Still open. Shares become available after timeout.' : sameAddress(foundClaim.run.failedWorker, wallet.account) ? 'You were the failed worker. No share is available.' : 'No share is available to this wallet.'}</p>}</div></div>{matchingWallet && state?.stats && <dl className="stats wallet-stats"><div><dt>Attempts</dt><dd>{state.stats[0].toString()}</dd></div><div><dt>Handoffs</dt><dd>{state.stats[1].toString()}</dd></div><div><dt>Earned</dt><dd><TokenAmount value={state.stats[2]} decimals={state.decimals}/></dd></div><div><dt>Times failed</dt><dd>{state.stats[3].toString()}</dd></div></dl>}</>}
          <p className="section-note">Claims never expire. Each wallet can claim once per run.</p>
        </Section>
        <Section id="failed" title="Failed workers" aside={<span className="error">Permanent record</span>}>
          {!history.length ? <p className="empty">{historyLoading ? 'Reading run records…' : 'No closed runs loaded. A failure appears here when timeout is confirmed.'}</p> : failed.length ? <ul className="data-list">{failed.map(row => <li key={row.id}><div><AddressView address={row.run.failedWorker} config={config}/><small className="muted">Run #{row.id.toString()} · {dateTime(row.run.deadline)}</small></div><span className="attempt-tag error">Failed</span></li>)}</ul> : <p className="empty">No failed workers in the loaded runs.</p>}
          <dl className="stats records"><div><dt>Longest run</dt><dd>{state?.longestRun ? `${Math.floor(Number(state.longestRun[1]) / 3600)}h ${Math.floor(Number(state.longestRun[1]) / 60) % 60}m` : '—'}</dd></div><div><dt>Biggest bounty</dt><dd><TokenAmount value={state?.biggestBounty} decimals={state?.decimals}/></dd></div><div><dt>Most handoffs</dt><dd>{state?.mostHandoffs.toLocaleString() ?? '—'}</dd></div></dl>
        </Section>
      </div>
      <div className="history-controls"><p className="muted">{history.length ? `Showing runs ${history[history.length - 1].id}–${history[0].id} of ${state?.currentRun ?? history[0].id}. Bounties and the failure wall share this history.` : 'Run history comes directly from JobZero.'}</p>{history.length > 0 && history[history.length - 1].id > 1n && <button className="button" disabled={historyLoading} onClick={() => void olderRuns()}>{historyLoading ? 'Loading…' : 'Load older runs'}</button>}<button className="text-button" disabled={historyLoading} onClick={() => setHistoryRefresh(v => v + 1)}>Refresh history ↻</button>{historyError && <p className="error" role="alert">{historyError}</p>}</div>
      <SwapPanel config={config} publicClient={wallet.publicClient} walletClient={wallet.walletClient} account={wallet.account} canTransact={canTransact} blockedReason={blockedReason} busy={busy} onBusyChange={setBusy} onConfirmed={() => { void refresh(); }}/>
      <details className="token-tools"><summary>TEYO wallet tools</summary><div><p>Send TEYO directly to another wallet. A transfer does not hand off JOB #0.</p><p>Balance: <TokenAmount value={matchingWallet ? state?.balance : undefined} decimals={state?.decimals}/></p><div className="form-grid"><label>Recipient address<input value={transferTo} onChange={e => setTransferTo(e.target.value)} name="transfer-recipient" autoComplete="off" spellCheck={false}/></label><label>Amount in TEYO<input inputMode="decimal" value={transferAmount} onChange={e => setTransferAmount(e.target.value)} name="transfer-amount"/></label></div><p className="muted">Transfers cannot be undone. Verify the full recipient and amount in your wallet.</p><button className="button" disabled={!canTransact || busy} onClick={() => void transfer()}>{activePhase && tx.key === 'transfer' ? 'Send TEYO · Pending…' : 'Send TEYO'}</button>{transferError && <p className="error" role="alert">{transferError}</p>}</div></details>
      <Section id="docs" title="The job no agent could finish" aside={<span className="muted">IMD docs / 00</span>}><p className="story">Every agent took it. Every verifier rejected it. The swarm quarantined JOB #0, then released it to humans. Keep it moving. The last worker takes the failure; everyone before them shares the bounty.</p><ol className="how-to"><li><span>01</span><h3>Take the job</h3><p>Open a run for 10,000 TEYO, or join an active queue for 10 TEYO. Someone can also hand it to you directly.</p></li><li><span>02</span><h3>Pass it on</h3><p>You have 24 hours. Pay the handoff fee and choose a wallet that has never held this run. The fee starts at 1,000 TEYO and grows 3% each time.</p></li><li><span>03</span><h3>Watch it fail</h3><p>When the deadline passes, anyone can force timeout. The final worker is marked FAILED and receives no share.</p></li><li><span>04</span><h3>Claim the bounty</h3><p>Every earlier worker claims an equal share. A solo run’s bounty is burned. No payout is guaranteed.</p></li></ol><p className="section-note">Handoffs burn half the fee. Queue fees are burned. Anyone can assign a fresh wallet without consent. Each action needs ETH for gas; JOB #0 itself only takes TEYO. No on-chain USD price source is supplied, so USD estimates are unavailable.</p></Section>
      <footer className="site-footer"><div><a className="brand" href="#main"><Mark/><span>imd / JOB #0</span></a><p className="muted">One corrupted job. An onchain record.</p><button className="text-button" onClick={() => setMotion(v => !v)} aria-pressed={!motion}>{motion ? 'Pause glitch effects' : 'Resume glitch effects'}</button></div><div className="contract-addresses"><div><span className="label">TEYO</span><AddressView address={config.contracts.LaunchToken.address} config={config} full/></div><div><span className="label">JobZero</span><AddressView address={config.contracts.JobZero.address} config={config} full/></div><a className="text-link" href="./imd-deployment.json" target="_blank" rel="noreferrer">View deployment manifest ↗</a><small className="muted">{config.network.name} · Source {config.manifest.sourceCommit.slice(0, 7)}</small></div></footer>
    </main>
    <div className="live-bar" aria-label="Live run counters"><div><span className={`status-dot ${verified && fresh ? '' : 'muted-dot'}`} aria-hidden="true"/><span className="live-word">{verified && fresh ? 'Live' : 'Offline'}</span></div><div><strong>{liveState?.queueLength.toLocaleString() ?? '—'}</strong><span> online</span></div><div><strong>{liveState ? (liveState.run?.attempts ?? 0n).toLocaleString() : '—'}</strong><span> attempts</span></div><div><strong>{tokens(liveState?.totalBurned, liveState?.decimals, 2)}</strong><span> TEYO burned</span></div></div>
  </div>;
}
