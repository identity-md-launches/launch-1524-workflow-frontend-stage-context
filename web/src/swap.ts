import { encodeAbiParameters, formatUnits, parseUnits, zeroAddress, type Address, type Hex } from 'viem'

/** The attested pool key is passed through unchanged to quotes and swaps. */
export interface SwapPoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export const QUOTE_LIFETIME_MS = 30_000
export const SWAP_DEADLINE_SECONDS = 120
export const PERMIT_LIFETIME_SECONDS = 30 * 60
export const MAX_EXACT_INPUT = (1n << 128n) - 1n

export const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

export function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

export function zeroForOne(poolKey: SwapPoolKey, input: Address, output: Address): boolean {
  if (sameAddress(input, poolKey.currency0) && sameAddress(output, poolKey.currency1)) return true
  if (sameAddress(input, poolKey.currency1) && sameAddress(output, poolKey.currency0)) return false
  throw new Error('The selected currencies do not match the verified pool.')
}

/** Reject rounding, exponent notation, signs and values the v4 input tuple cannot hold. */
export function parseSwapAmount(value: string, decimals: number): bigint {
  const normalized = value.trim()
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a positive token amount.')
  if ((normalized.split('.')[1]?.length ?? 0) > decimals) {
    throw new Error(`This token supports at most ${decimals} decimal places.`)
  }
  const amount = parseUnits(normalized, decimals)
  if (amount <= 0n) throw new Error('Enter an amount greater than zero.')
  if (amount > MAX_EXACT_INPUT) throw new Error('This amount is too large for a single swap.')
  return amount
}

/** The UI accepts percentages to two decimal places, from 0.1% through 5%. */
export function slippageBasisPoints(percent: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(percent)) throw new Error('Use a slippage between 0.1% and 5%.')
  const bps = Number(parseUnits(percent, 2))
  if (!Number.isSafeInteger(bps) || bps < 10 || bps > 500) {
    throw new Error('Use a slippage between 0.1% and 5%.')
  }
  return bps
}

export function minimumOutput(quoted: bigint, slippageBps: number): bigint {
  if (quoted <= 0n) throw new Error('The pool returned no output for this amount.')
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error('Invalid slippage tolerance.')
  }
  const minimum = quoted * BigInt(10_000 - slippageBps) / 10_000n
  if (minimum === 0n) throw new Error('Increase the amount; the minimum received rounds to zero.')
  return minimum
}

/** Human-readable output units per input unit, without floating point conversion. */
export function exchangeRate(input: bigint, output: bigint, inputDecimals: number, outputDecimals: number): string {
  if (input <= 0n) return '—'
  const precision = 8
  const scaled = output * 10n ** BigInt(inputDecimals + precision) / (input * 10n ** BigInt(outputDecimals))
  return scaled === 0n ? '<0.00000001' : formatUnits(scaled, precision)
}

export type SwapApprovalStep = 'token' | 'permit2' | 'swap'

export function requiredApproval({
  input, amount, tokenAllowance, permitAllowance, permitExpiration, nowSeconds,
}: {
  input: Address
  amount: bigint
  tokenAllowance: bigint
  permitAllowance: bigint
  permitExpiration: number
  nowSeconds: number
}): SwapApprovalStep {
  if (sameAddress(input, zeroAddress)) return 'swap'
  if (tokenAllowance < amount) return 'token'
  // A Permit2 allowance must survive the complete execution window.
  if (permitAllowance < amount || permitExpiration <= nowSeconds + SWAP_DEADLINE_SECONDS) return 'permit2'
  return 'swap'
}

export function buildSwapExecution({
  poolKey, input, output, amountIn, amountOutMinimum, extendedSwapParams = false, nowSeconds,
}: {
  poolKey: SwapPoolKey
  input: Address
  output: Address
  amountIn: bigint
  amountOutMinimum: bigint
  extendedSwapParams?: boolean
  nowSeconds: number
}): { commands: Hex; inputs: readonly Hex[]; deadline: bigint; value: bigint } {
  if (amountIn <= 0n || amountIn > MAX_EXACT_INPUT) throw new Error('Invalid swap input amount.')
  if (amountOutMinimum <= 0n || amountOutMinimum > MAX_EXACT_INPUT) throw new Error('Invalid minimum output amount.')
  const direction = zeroForOne(poolKey, input, output)
  const head = [
    { name: 'poolKey', type: 'tuple', components: poolKeyComponents },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
  ] as const
  const hookData = '0x' as Hex
  const swap = extendedSwapParams
    ? encodeAbiParameters([{ type: 'tuple', components: [...head, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey, zeroForOne: direction, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData }])
    : encodeAbiParameters([{ type: 'tuple', components: [...head, { name: 'hookData', type: 'bytes' }] }], [{ poolKey, zeroForOne: direction, amountIn, amountOutMinimum, hookData }])
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [input, amountIn])
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [output, amountOutMinimum])
  const actions = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', [swap, settle, take]])
  return {
    commands: '0x10',
    inputs: [actions],
    deadline: BigInt(nowSeconds + SWAP_DEADLINE_SECONDS),
    value: sameAddress(input, zeroAddress) ? amountIn : 0n,
  }
}
