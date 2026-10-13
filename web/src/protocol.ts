import { erc20Abi as standardErc20Abi, parseAbi } from 'viem'

// Protocol interfaces are centralized here; protocol addresses come only from
// imd-deployment.json's validated network.uniswapV4 block at runtime.
export const erc20Abi = [...standardErc20Abi, ...parseAbi([
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InvalidSpender(address spender)',
])] as const

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
])

export const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error NotEnoughLiquidity(bytes32 poolId)',
])

export const routerAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
  'error Error(string reason)',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error TransactionDeadlinePassed()',
  'error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)',
])
