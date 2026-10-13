import assert from 'node:assert/strict'
import test from 'node:test'
import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, encodeErrorResult, UserRejectedRequestError, zeroAddress, type Address } from 'viem'
import { errorText } from '../src/SwapPanel'
import { quoterAbi, routerAbi } from '../src/protocol'
import {
  buildSwapExecution, exchangeRate, MAX_EXACT_INPUT, minimumOutput,
  parseSwapAmount, poolKeyComponents, requiredApproval, slippageBasisPoints, zeroForOne,
} from '../src/swap'

// Test-only addresses exercise ordering without introducing runtime configuration.
const token = '0x0000000000000000000000000000000000000001' as Address
const pair = '0x0000000000000000000000000000000000000002' as Address
const hook = '0x0000000000000000000000000000000000000003' as Address
const poolKey = { currency0: token, currency1: pair, fee: 12500, tickSpacing: 60, hooks: hook }

test('buy/sell direction follows the actual pool ordering, including the reversed order', () => {
  assert.equal(zeroForOne(poolKey, pair, token), false)
  assert.equal(zeroForOne(poolKey, token, pair), true)
  const reversed = { ...poolKey, currency0: pair, currency1: token }
  assert.equal(zeroForOne(reversed, pair, token), true)
  assert.throws(() => zeroForOne(poolKey, hook, token), /do not match/)
})

test('amounts honor token decimals and reject rounding, negative, exponent and overflowing values', () => {
  assert.equal(parseSwapAmount('1.123456', 6), 1123456n)
  assert.equal(parseSwapAmount(' 100.000000000000000001 ', 18), 100000000000000000001n)
  for (const amount of ['0', '-1', '1e5', '1,000', '1.', '']) assert.throws(() => parseSwapAmount(amount, 18))
  assert.throws(() => parseSwapAmount('1.0000001', 6), /decimal places/)
  assert.throws(() => parseSwapAmount((MAX_EXACT_INPUT + 1n).toString(), 0), /too large/)
})

test('minimum output floors precisely with a bounded user slippage value', () => {
  assert.equal(slippageBasisPoints('0.5'), 50)
  assert.equal(slippageBasisPoints('5'), 500)
  assert.equal(minimumOutput(10_001n, 50), 9_950n)
  assert.throws(() => slippageBasisPoints('0.01'))
  assert.throws(() => slippageBasisPoints('5.01'))
  assert.throws(() => slippageBasisPoints('1.001'))
  assert.throws(() => minimumOutput(1n, 500), /rounds to zero/)
  assert.throws(() => minimumOutput(0n, 50), /no output/)
})

test('exchange rates account for different decimals without floating-point loss', () => {
  assert.equal(exchangeRate(2_000000n, 3_000000000000000000n, 6, 18), '1.5')
  assert.equal(exchangeRate(3_000000000000000000n, 6_000000n, 18, 6), '2')
  assert.equal(exchangeRate(10n ** 28n, 1n, 18, 18), '<0.00000001')
})

test('approval steps use fresh token and Permit2 allowances and expiry; native input needs none', () => {
  const state = { input: token, amount: 100n, tokenAllowance: 0n, permitAllowance: 0n, permitExpiration: 0, nowSeconds: 1000 }
  assert.equal(requiredApproval(state), 'token')
  assert.equal(requiredApproval({ ...state, tokenAllowance: 100n }), 'permit2')
  assert.equal(requiredApproval({ ...state, tokenAllowance: 100n, permitAllowance: 100n, permitExpiration: 1120 }), 'permit2')
  assert.equal(requiredApproval({ ...state, tokenAllowance: 100n, permitAllowance: 100n, permitExpiration: 1121 }), 'swap')
  assert.equal(requiredApproval({ ...state, input: zeroAddress }), 'swap')
})

for (const extendedSwapParams of [false, true]) {
  test(`router payload preserves the attested pool and exact amounts (${extendedSwapParams ? 'extended' : 'standard'} tuple)`, () => {
    const execution = buildSwapExecution({ poolKey, input: pair, output: token, amountIn: 100n, amountOutMinimum: 95n, nowSeconds: 1000, extendedSwapParams })
    assert.equal(execution.commands, '0x10')
    assert.equal(execution.value, 0n)
    assert.equal(execution.deadline, 1120n)
    assert.equal(execution.inputs.length, 1)
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], execution.inputs[0])
    assert.equal(actions, '0x060c0f')
    assert.equal(params.length, 3)
    const components = [
      { type: 'tuple', name: 'poolKey', components: poolKeyComponents },
      { type: 'bool', name: 'zeroForOne' },
      { type: 'uint128', name: 'amountIn' },
      { type: 'uint128', name: 'amountOutMinimum' },
      ...(extendedSwapParams ? [{ type: 'uint256', name: 'minHopPriceX36' }] : []),
      { type: 'bytes', name: 'hookData' },
    ] as const
    const [swap] = decodeAbiParameters([{ type: 'tuple', components }], params[0]) as unknown as [{ poolKey: typeof poolKey; zeroForOne: boolean; amountIn: bigint; amountOutMinimum: bigint; hookData: string; minHopPriceX36?: bigint }]
    assert.deepEqual(swap.poolKey, poolKey)
    assert.equal(swap.zeroForOne, false)
    assert.equal(swap.amountIn, 100n)
    assert.equal(swap.amountOutMinimum, 95n)
    assert.equal(swap.hookData, '0x')
    if (extendedSwapParams) assert.equal(swap.minHopPriceX36, 0n)
    assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]), [pair, 100n])
    assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]), [token, 95n])
  })
}

test('native input sends precisely amountIn while ERC20 swaps send no native value', () => {
  const nativePool = { ...poolKey, currency0: zeroAddress, currency1: token }
  assert.equal(buildSwapExecution({ poolKey: nativePool, input: zeroAddress, output: token, amountIn: 100n, amountOutMinimum: 50n, nowSeconds: 0 }).value, 100n)
  assert.equal(buildSwapExecution({ poolKey: nativePool, input: token, output: zeroAddress, amountIn: 100n, amountOutMinimum: 50n, nowSeconds: 0 }).value, 0n)
})

test('wallet rejection is distinguished from contract and router reverts', () => {
  assert.match(errorText({ code: 4001, message: 'Cancelled' }), /rejected in your wallet/)
  assert.match(errorText(new BaseError('Wallet request failed', { cause: new UserRejectedRequestError(new Error('Cancelled')) })), /rejected in your wallet/)
  assert.match(errorText(new Error('User denied transaction signature.')), /rejected in your wallet/)
  assert.equal(errorText(new Error('The contract rejected the requested handoff.')), 'The contract rejected the requested handoff.')
  const deadline = new ContractFunctionRevertedError({ abi: routerAbi, functionName: 'execute', data: encodeErrorResult({ abi: routerAbi, errorName: 'TransactionDeadlinePassed' }) })
  assert.match(errorText(deadline), /deadline passed/)
  assert.doesNotMatch(errorText(deadline), /rejected in your wallet/)
  const slippage = encodeErrorResult({ abi: routerAbi, errorName: 'V4TooLittleReceived', args: [100n, 99n] })
  const execution = new ContractFunctionRevertedError({ abi: routerAbi, functionName: 'execute', data: encodeErrorResult({ abi: routerAbi, errorName: 'ExecutionFailed', args: [0n, slippage] }) })
  assert.match(errorText(execution), /price moved beyond your slippage limit/)
  const reason = encodeErrorResult({ abi: routerAbi, errorName: 'Error', args: ['Pool rejected expired intent'] })
  const stringRevert = new ContractFunctionRevertedError({ abi: routerAbi, functionName: 'execute', data: encodeErrorResult({ abi: routerAbi, errorName: 'ExecutionFailed', args: [0n, reason] }) })
  assert.equal(errorText(stringRevert), 'Pool rejected expired intent')
})

test('actual nested quoter liquidity revert is decoded as pool state, not wallet rejection', () => {
  const data = '0x6190b2b0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000247a5ed7344dc1ebd4d52b7f1f5d7b3b25b400a4e8d5143e39a6c9b92af289fb7d57202e5700000000000000000000000000000000000000000000000000000000'
  const error = new ContractFunctionRevertedError({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data })
  assert.match(errorText(error), /pool cannot fill this amount in this direction with its current liquidity/)
  assert.match(errorText(error), /No transaction was sent/)
  assert.doesNotMatch(errorText(error), /rejected in your wallet|UnexpectedRevertBytes|0x6190/)
})
