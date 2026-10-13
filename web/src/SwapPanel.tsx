import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, formatUnits, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'
import type { RuntimeConfig } from './config'
import { erc20Abi, permit2Abi, quoterAbi, routerAbi } from './protocol'
import {
  buildSwapExecution, exchangeRate, minimumOutput, parseSwapAmount,
  PERMIT_LIFETIME_SECONDS, QUOTE_LIFETIME_MS, requiredApproval, sameAddress,
  slippageBasisPoints, zeroForOne,
} from './swap'

export interface SwapPanelProps {
  config: RuntimeConfig
  publicClient: PublicClient
  walletClient?: WalletClient
  account?: Address
  canTransact: boolean
  blockedReason?: string
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onConfirmed: () => void
}

interface Currency { address: Address; symbol: string; decimals: number; abi: Abi }
interface Funds { balance: bigint; tokenAllowance: bigint; permitAllowance: bigint; permitExpiration: number }
interface Quote { amountIn: bigint; amountOut: bigint; minimum: bigint; timestamp: number; fingerprint: string }
interface UnconfirmedTransaction { hash: Hex; owner: Address; currency: Currency; step: 'token' | 'permit2' | 'swap'; title: string; replacement?: string }
type PendingAction = 'quote' | 'token' | 'permit2' | 'swap' | null

export function errorText(error: unknown): string {
  let cause: unknown = error
  const visited = new Set<unknown>()
  let walletRejected = false
  while (cause && typeof cause === 'object' && !visited.has(cause)) {
    visited.add(cause)
    if ('code' in cause && Number(cause.code) === 4001) walletRejected = true
    cause = 'cause' in cause ? cause.cause : undefined
  }
  let message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error)
  if (error instanceof BaseError) {
    const revert = error.walk(cause => cause instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.reason) message = revert.reason
      else if (revert.data) {
        message = `The contract rejected this action: ${revert.data.errorName}.`
        // Router and quoter wrap underlying v4 errors in different byte fields.
        const wrapped = revert.data.errorName === 'ExecutionFailed' ? revert.data.args?.[1]
          : revert.data.errorName === 'UnexpectedRevertBytes' ? revert.data.args?.[0] : undefined
        if (typeof wrapped === 'string') {
          try {
            const underlying = decodeErrorResult({ abi: [...quoterAbi, ...routerAbi, ...permit2Abi, ...erc20Abi], data: wrapped as Hex })
            message = `The pool rejected this swap: ${underlying.errorName}.`
            if (underlying.errorName === 'Error' && typeof underlying.args?.[0] === 'string') message = underlying.args[0]
          } catch { message = 'The swap could not be simulated. Refresh the quote and check the pool liquidity and token approvals.' }
        }
      }
    }
  }
  if (walletRejected || /user (?:rejected|denied)|request (?:rejected|denied) by (?:the )?user/i.test(message)) return 'Request rejected in your wallet. No new transaction was sent by this request.'
  if (/insufficient funds|ERC20InsufficientBalance/i.test(message)) return 'Your wallet needs enough ETH for network fees and enough input tokens.'
  if (/V4TooLittleReceived|TooLittleReceived/i.test(message)) return 'The price moved beyond your slippage limit. Get a fresh quote.'
  if (/TransactionDeadlinePassed/i.test(message)) return 'The transaction deadline passed. Get a fresh quote.'
  if (/AllowanceExpired|InsufficientAllowance/i.test(message)) return 'A token allowance is insufficient or expired. Refresh the quote and complete the approval step.'
  if (/NotEnoughLiquidity/i.test(message)) return 'The pool cannot fill this amount in this direction with its current liquidity. Try a smaller amount or retry after liquidity changes. No transaction was sent.'
  return message.slice(0, 400)
}

function displayAmount(value: bigint, decimals: number) {
  return formatUnits(value, decimals)
}

export function SwapPanel({ config, publicClient, walletClient, account, canTransact, blockedReason, busy, onBusyChange, onConfirmed }: SwapPanelProps) {
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState('0.5')
  const [currencies, setCurrencies] = useState<{ token: Currency; pair: Currency }>()
  const [verified, setVerified] = useState(false)
  const [verificationError, setVerificationError] = useState('')
  const [verificationAttempt, setVerificationAttempt] = useState(0)
  const [funds, setFunds] = useState<Funds>()
  const [fundsError, setFundsError] = useState('')
  const [quote, setQuote] = useState<Quote>()
  const [pending, setPending] = useState<PendingAction>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [txHash, setTxHash] = useState<Hex>()
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedTransaction>()
  const [checkingReceipt, setCheckingReceipt] = useState(false)
  const [now, setNow] = useState(Date.now())
  const actionLock = useRef(false)
  const requestVersion = useRef(0)
  const fundsVersion = useRef(0)
  const latestAccount = useRef(account)
  latestAccount.current = account
  const { uniswapV4 } = config.network
  const launchToken = config.contracts.LaunchToken
  const pair = config.network.pairToken
  const input = direction === 'buy' ? currencies?.pair : currencies?.token
  const output = direction === 'buy' ? currencies?.token : currencies?.pair
  const fingerprint = `${direction}:${amount}:${slippage}:${account ?? ''}`
  const latestFingerprint = useRef(fingerprint)
  latestFingerprint.current = fingerprint
  const validQuote = quote && quote.fingerprint === fingerprint && (now - quote.timestamp < QUOTE_LIFETIME_MS || (pending !== null && pending !== 'quote')) ? quote : undefined
  const locked = busy || pending !== null

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    setVerified(false)
    setVerificationError('')
    setCurrencies(undefined)
    async function verify() {
      if (!launchToken || !pair) throw new Error('The verified pool currencies are not configured.')
      zeroForOne(config.poolKey, launchToken.address, pair.address)
      const chainId = await publicClient.getChainId()
      if (chainId !== config.manifest.chainId) throw new Error('The swap RPC reports a different network. Trading is disabled.')
      const addresses = [launchToken.address, pair.address, uniswapV4.poolManager, uniswapV4.universalRouter, uniswapV4.quoter, uniswapV4.permit2, config.poolKey.hooks]
      const uniqueAddresses = [...new Set(addresses)]
      const codes = await Promise.all(uniqueAddresses.map(address => publicClient.getBytecode({ address })))
      const missingCode = codes.findIndex(code => !code || code === '0x')
      if (missingCode !== -1) throw new Error(`No contract code at ${uniqueAddresses[missingCode]}. Trading is disabled.`)
      const [tokenDecimals, tokenSymbol, pairDecimals, pairSymbol] = await Promise.all([
        publicClient.readContract({ address: launchToken.address, abi: launchToken.abi, functionName: 'decimals' }),
        publicClient.readContract({ address: launchToken.address, abi: launchToken.abi, functionName: 'symbol' }),
        publicClient.readContract({ address: pair.address, abi: erc20Abi, functionName: 'decimals' }),
        publicClient.readContract({ address: pair.address, abi: erc20Abi, functionName: 'symbol' }),
      ])
      if (Number(pairDecimals) !== pair.decimals || pairSymbol !== pair.symbol) throw new Error('The paired token does not match the verified network metadata.')
      if (!cancelled) {
        setCurrencies({
          token: { address: launchToken.address, symbol: String(tokenSymbol), decimals: Number(tokenDecimals), abi: launchToken.abi },
          pair: { address: pair.address, symbol: pairSymbol, decimals: pairDecimals, abi: erc20Abi },
        })
        setVerified(true)
      }
    }
    void verify().catch(reason => { if (!cancelled) setVerificationError(errorText(reason)) })
    return () => { cancelled = true }
  }, [config, publicClient, launchToken, pair, uniswapV4, verificationAttempt])

  const readFunds = useCallback(async (currency: Currency, owner: Address): Promise<Funds> => {
    const [balance, tokenAllowance, permit] = await Promise.all([
      publicClient.readContract({ address: currency.address, abi: currency.abi, functionName: 'balanceOf', args: [owner] }),
      publicClient.readContract({ address: currency.address, abi: currency.abi, functionName: 'allowance', args: [owner, uniswapV4.permit2] }),
      publicClient.readContract({ address: uniswapV4.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, currency.address, uniswapV4.universalRouter] }),
    ])
    return { balance: balance as bigint, tokenAllowance: tokenAllowance as bigint, permitAllowance: permit[0], permitExpiration: permit[1] }
  }, [publicClient, uniswapV4])

  useEffect(() => {
    let cancelled = false
    fundsVersion.current += 1
    setFunds(undefined)
    setFundsError('')
    if (!account || !input || !verified) return
    const refresh = async () => {
      const version = ++fundsVersion.current
      try {
        const next = await readFunds(input, account)
        if (!cancelled && version === fundsVersion.current) { setFunds(next); setFundsError('') }
      } catch (reason) {
        if (!cancelled && version === fundsVersion.current) { setFunds(undefined); setFundsError(errorText(reason)) }
      }
    }
    void refresh()
    const timer = window.setInterval(() => { if (!actionLock.current) void refresh() }, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [account, input, readFunds, verified])

  useEffect(() => {
    requestVersion.current += 1
    setQuote(undefined)
    // An external account switch must not erase an in-flight transaction warning.
    if (pending === null || pending === 'quote') { setError(''); setStatus('') }
  }, [fingerprint])

  const parsed = useMemo(() => {
    if (!input || !amount.trim()) return { amount: undefined, bps: undefined, error: '' }
    try { return { amount: parseSwapAmount(amount, input.decimals), bps: slippageBasisPoints(slippage), error: '' } }
    catch (reason) { return { amount: undefined, bps: undefined, error: errorText(reason) } }
  }, [amount, slippage, input])

  const approval = validQuote && input && funds
    ? requiredApproval({ input: input.address, amount: validQuote.amountIn, ...funds, nowSeconds: Math.floor(now / 1_000) })
    : undefined
  const insufficient = !!funds && !!parsed.amount && funds.balance < parsed.amount

  async function getQuote() {
    if (actionLock.current || !verified || !input || !output || !parsed.amount || parsed.bps === undefined) return
    actionLock.current = true
    fundsVersion.current += 1
    const version = ++requestVersion.current
    setPending('quote'); setError(''); setStatus('Simulating a quote. This does not send a transaction.'); setQuote(undefined)
    try {
      const simulation = await publicClient.simulateContract({
        address: uniswapV4.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ poolKey: config.poolKey, zeroForOne: zeroForOne(config.poolKey, input.address, output.address), exactAmount: parsed.amount, hookData: '0x' }],
      })
      const newFunds = account ? await readFunds(input, account) : undefined
      if (version !== requestVersion.current || latestFingerprint.current !== fingerprint) return
      setFunds(newFunds)
      setFundsError('')
      const timestamp = Date.now()
      setNow(timestamp)
      setQuote({ amountIn: parsed.amount, amountOut: simulation.result[0], minimum: minimumOutput(simulation.result[0], parsed.bps), timestamp, fingerprint })
      setStatus('Quote ready. Review the amounts and approvals before signing.')
    } catch (reason) {
      if (version === requestVersion.current) { setError(errorText(reason)); setStatus('') }
    } finally { actionLock.current = false; setPending(null) }
  }

  async function assertWallet(owner: Address) {
    if (!walletClient || !canTransact || !verified || !sameAddress(latestAccount.current ?? '', owner)) throw new Error('Connect the verified wallet on the correct network before continuing.')
    const [walletChain, rpcChain, accounts] = await Promise.all([walletClient.getChainId(), publicClient.getChainId(), walletClient.getAddresses()])
    if (walletChain !== config.manifest.chainId || rpcChain !== config.manifest.chainId) throw new Error(`Switch your wallet to ${config.network.name} before continuing.`)
    if (!accounts[0] || !sameAddress(accounts[0], owner) || !sameAddress(latestAccount.current ?? '', owner)) throw new Error('The connected wallet changed. Review the transaction again.')
  }

  async function submitStep() {
    if (actionLock.current || locked || !validQuote || !input || !output || !account || !walletClient || !canTransact || !approval || insufficient) return
    actionLock.current = true
    fundsVersion.current += 1
    onBusyChange(true)
    setPending(approval); setError(''); setTxHash(undefined)
    const owner = account
    let waiting: UnconfirmedTransaction | undefined
    try {
      await assertWallet(owner)
      const fresh = await readFunds(input, owner)
      setFunds(fresh)
      if (fresh.balance < validQuote.amountIn) throw new Error(`Not enough ${input.symbol} for this swap.`)
      const step = requiredApproval({ input: input.address, amount: validQuote.amountIn, ...fresh, nowSeconds: Math.floor(Date.now() / 1_000) })
      if (step !== approval) throw new Error('Your allowances changed. Review the updated step before signing.')
      const title = step === 'token' ? `Approve ${input.symbol} for Permit2` : step === 'permit2' ? 'Approve the router in Permit2' : `Swap ${input.symbol} for ${output.symbol}`
      setStatus(`Simulating: ${title}.`)
      let hash: Hex
      if (step === 'token') {
        const simulation = await publicClient.simulateContract({ address: input.address, abi: input.abi, functionName: 'approve', args: [uniswapV4.permit2, validQuote.amountIn], account: owner })
        await assertWallet(owner)
        setStatus(`Confirm in your wallet: allow Permit2 to spend exactly ${displayAmount(validQuote.amountIn, input.decimals)} ${input.symbol}.`)
        hash = await walletClient.writeContract({ ...simulation.request, chain: config.chain, account: owner })
      } else if (step === 'permit2') {
        const expiration = Math.floor(Date.now() / 1_000) + PERMIT_LIFETIME_SECONDS
        const simulation = await publicClient.simulateContract({ address: uniswapV4.permit2, abi: permit2Abi, functionName: 'approve', args: [input.address, uniswapV4.universalRouter, validQuote.amountIn, expiration], account: owner })
        await assertWallet(owner)
        setStatus(`Confirm in your wallet: let the router spend exactly ${displayAmount(validQuote.amountIn, input.decimals)} ${input.symbol} through Permit2 for 30 minutes.`)
        hash = await walletClient.writeContract({ ...simulation.request, chain: config.chain, account: owner })
      } else {
        if (Date.now() - validQuote.timestamp >= QUOTE_LIFETIME_MS || latestFingerprint.current !== fingerprint) throw new Error('The quote expired or changed. Get a fresh quote.')
        const execution = buildSwapExecution({ poolKey: config.poolKey, input: input.address, output: output.address, amountIn: validQuote.amountIn, amountOutMinimum: validQuote.minimum, extendedSwapParams: uniswapV4.extendedSwapParams, nowSeconds: Math.floor(Date.now() / 1_000) })
        const simulation = await publicClient.simulateContract({ address: uniswapV4.universalRouter, abi: routerAbi, functionName: 'execute', args: [execution.commands, execution.inputs, execution.deadline], value: execution.value, account: owner })
        await assertWallet(owner)
        if (Date.now() - validQuote.timestamp >= QUOTE_LIFETIME_MS) throw new Error('The quote expired during simulation. Get a fresh quote.')
        setStatus(`Confirm in your wallet: spend ${displayAmount(validQuote.amountIn, input.decimals)} ${input.symbol}; receive at least ${displayAmount(validQuote.minimum, output.decimals)} ${output.symbol}.`)
        hash = await walletClient.writeContract({ ...simulation.request, chain: config.chain, account: owner })
      }
      setTxHash(hash)
      setStatus(`${title}: waiting for onchain confirmation.`)
      waiting = { hash, owner, currency: input, step, title }
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        onReplaced: replacement => {
          if (waiting) waiting = { ...waiting, hash: replacement.transaction.hash, replacement: replacement.reason }
          setTxHash(replacement.transaction.hash)
        },
      })
      const settled = waiting
      waiting = undefined
      await finishReceipt(settled, receipt.status)
    } catch (reason) {
      if (waiting) {
        setUnconfirmed(waiting)
        setError('The transaction was sent, but its confirmation could not be determined. Keep this page open and recheck its receipt before submitting another transaction.')
        setStatus('Confirmation unknown. Transaction controls remain locked.')
      } else { setError(errorText(reason)); setStatus('') }
    } finally {
      if (!waiting) { actionLock.current = false; setPending(null); onBusyChange(false) }
    }
  }

  async function finishReceipt(transaction: UnconfirmedTransaction, receiptStatus: 'success' | 'reverted') {
    fundsVersion.current += 1
    setFunds(undefined)
    setQuote(undefined)
    if (receiptStatus !== 'success') throw new Error('The transaction reverted. Check its explorer record; this transaction did not complete the requested action.')
    setStatus('Receipt confirmed. Refreshing balances and allowances before the next action.')
    try {
      const updated = await readFunds(transaction.currency, transaction.owner)
      if (sameAddress(latestAccount.current ?? '', transaction.owner)) { setFunds(updated); setFundsError('') }
    } catch (reason) {
      setFundsError(errorText(reason))
      setStatus(`${transaction.title} has a confirmed receipt. Balances and allowances are unavailable; refresh them before continuing.`)
      onConfirmed()
      return
    }
    setStatus(transaction.replacement && transaction.replacement !== 'repriced'
      ? 'The original transaction was replaced or cancelled. Balances and allowances have been refreshed; review them before continuing.'
      : `${transaction.title} confirmed.${transaction.step === 'swap' ? '' : ' The allowance has been refreshed from the chain. Get a fresh quote for the next step.'}`)
    onConfirmed()
  }

  async function recheckReceipt() {
    if (!unconfirmed || checkingReceipt) return
    setCheckingReceipt(true)
    let settled = false
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: unconfirmed.hash })
      settled = true
      setError('')
      await finishReceipt(unconfirmed, receipt.status)
    } catch (reason) {
      setError(settled ? errorText(reason) : 'A confirmed receipt is still unavailable. The transaction controls remain locked; inspect the explorer and recheck again.')
    } finally {
      setCheckingReceipt(false)
      if (settled) { setUnconfirmed(undefined); actionLock.current = false; setPending(null); onBusyChange(false) }
    }
  }

  const inputSymbol = input?.symbol ?? (direction === 'buy' ? pair?.symbol ?? 'paired token' : 'TEYO')
  const outputSymbol = output?.symbol ?? (direction === 'buy' ? 'TEYO' : pair?.symbol ?? 'paired token')
  const quoteSeconds = validQuote ? Math.max(0, Math.ceil((validQuote.timestamp + QUOTE_LIFETIME_MS - now) / 1_000)) : 0
  const actionLabel = approval === 'token' ? `1. Approve ${inputSymbol} for Permit2` : approval === 'permit2' ? '2. Approve router in Permit2' : `3. Swap ${inputSymbol} for ${outputSymbol}`
  const pendingLabel = pending === 'token' ? `Approving ${inputSymbol}…` : pending === 'permit2' ? 'Approving router…' : 'Swapping…'

  return <section className="panel swap-panel" aria-labelledby="swap-title" id="trade">
    <div className="section-header"><h2 id="swap-title">Trade TEYO</h2><span className="muted">Pool fee {config.poolKey.fee / 10_000}%</span></div>
    <p>Swap against the verified {pair?.symbol ?? 'paired token'} pool. You need ETH for network fees.</p>
    <div className="swap-directions" role="group" aria-label="Trade direction">
      <button type="button" className={`button ${direction === 'buy' ? 'button-primary' : ''}`} aria-pressed={direction === 'buy'} disabled={locked} onClick={() => setDirection('buy')}>Buy TEYO</button>
      <button type="button" className={`button ${direction === 'sell' ? 'button-primary' : ''}`} aria-pressed={direction === 'sell'} disabled={locked} onClick={() => setDirection('sell')}>Sell TEYO</button>
    </div>
    <div className="form-grid">
      <label className="field" htmlFor="swap-amount">Spend {inputSymbol}
        <input id="swap-amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={amount} disabled={locked} onChange={event => setAmount(event.target.value)} aria-describedby="swap-balance swap-amount-error" />
      </label>
      <label className="field" htmlFor="swap-slippage">Slippage limit (%)
        <input id="swap-slippage" inputMode="decimal" autoComplete="off" value={slippage} disabled={locked} onChange={event => setSlippage(event.target.value)} aria-describedby="swap-slippage-help" />
      </label>
    </div>
    <p id="swap-balance" className="muted">{account ? funds && input ? `Balance: ${displayAmount(funds.balance, input.decimals)} ${inputSymbol}` : 'Balance: waiting for a verified chain read.' : 'Connect your wallet above to see your balance and trade.'}</p>
    <p id="swap-slippage-help" className="muted">Slippage allows price movement from your quote. Range: 0.1–5%. USD context is unavailable.</p>
    {parsed.error && <p className="error" id="swap-amount-error">{parsed.error}</p>}
    {insufficient && <p className="error">Not enough {inputSymbol}. Reduce the amount or fund your wallet.</p>}
    {!verified && <p className={verificationError ? 'error' : 'muted'}>{verificationError || 'Verifying the network, pool currencies and protocol contract code…'}</p>}
    {verificationError && <button type="button" className="button" disabled={locked} onClick={() => setVerificationAttempt(value => value + 1)}>Retry swap verification</button>}
    {fundsError && <p className="error">Could not refresh your balances or approvals: {fundsError}</p>}
    {validQuote && input && output && <div className="swap-quote">
      <dl className="stats">
        <div><dt>Estimated receive</dt><dd>{displayAmount(validQuote.amountOut, output.decimals)} {outputSymbol}</dd></div>
        <div><dt>Minimum received</dt><dd>{displayAmount(validQuote.minimum, output.decimals)} {outputSymbol}</dd></div>
        <div><dt>Quoted rate</dt><dd>1 {inputSymbol} ≈ {exchangeRate(validQuote.amountIn, validQuote.amountOut, input.decimals, output.decimals)} {outputSymbol}</dd></div>
      </dl>
      <p className="muted">{quoteSeconds > 0 ? `Quote expires in ${quoteSeconds}s.` : 'Quote expired; your submitted request is still being processed.'} Pool fee is included; network fees are additional.</p>
      <ol className="swap-steps">
        <li>Allow Permit2 to spend exactly the input amount{funds && funds.tokenAllowance >= validQuote.amountIn ? ' · Ready' : ''}.</li>
        <li>Allow the router through Permit2 for 30 minutes{funds && funds.permitAllowance >= validQuote.amountIn && funds.permitExpiration > Math.floor(now / 1_000) + 120 ? ' · Ready' : ''}.</li>
        <li>Simulate and sign the swap; receive at least the minimum above.</li>
      </ol>
    </div>}
    {!validQuote && <button type="button" className="button button-primary" disabled={locked || !verified || !parsed.amount || parsed.bps === undefined} onClick={() => void getQuote()}>{pending === 'quote' ? 'Getting quote…' : quote ? 'Refresh expired quote' : 'Get quote'}</button>}
    {validQuote && <div className="swap-actions">
      <button type="button" className="button button-primary" disabled={locked || !canTransact || !verified || !walletClient || !account || !funds || !approval || insufficient || !!fundsError} onClick={() => void submitStep()}>{pending && pending !== 'quote' ? pendingLabel : actionLabel}</button>
      <button type="button" className="button" disabled={locked} onClick={() => void getQuote()}>Refresh quote</button>
    </div>}
    {validQuote && !canTransact && <p className="notice">{blockedReason || 'Connect a wallet on the verified network using the controls at the top of the page.'}</p>}
    <div aria-live="polite" aria-atomic="true">{status && <p className="notice">{status}</p>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {unconfirmed && <button type="button" className="button" disabled={checkingReceipt} onClick={() => void recheckReceipt()}>{checkingReceipt ? 'Checking receipt…' : 'Recheck swap transaction'}</button>}
    {txHash && <p><a href={`${config.network.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction on the explorer ↗</a></p>}
  </section>
}

export default SwapPanel
