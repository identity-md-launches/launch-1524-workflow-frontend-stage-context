import {
  defineChain,
  isAddress,
  keccak256,
  sha256,
  stringToHex,
  type Abi,
  type Address,
  type Chain,
} from 'viem';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface TokenReference {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  id?: string;
}

export interface NetworkConfig {
  chainId: number;
  name: string;
  testnet: boolean;
  rpcUrls: string[];
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  faucets: unknown[];
  uniswapV4: {
    poolManager: Address;
    universalRouter: Address;
    quoter: Address;
    stateView: Address;
    positionManager: Address;
    permit2: Address;
    extendedSwapParams?: boolean;
  };
  pairToken: TokenReference;
  otherPairTokens?: TokenReference[];
}

export interface WalletAddChain {
  chainId: `0x${string}`;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: NetworkConfig['nativeCurrency'];
  blockExplorerUrls: string[];
}

export interface ContractReference {
  name: string;
  address: Address;
  abiHash: string;
  abiPath: string;
}

export interface DeploymentManifest {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: ContractReference[];
  assets: { path: string; sha256: string }[];
  poolKey: PoolKey;
  network: NetworkConfig;
  walletAddChain?: WalletAddChain;
}

export interface RuntimeConfig {
  manifest: DeploymentManifest;
  contracts: Record<string, ContractReference & { abi: Abi }>;
  chain: Chain;
  poolKey: PoolKey;
  network: NetworkConfig;
}

const hashPattern = /^[0-9a-f]{64}$/;
const allowedKeys = new Set(['version', 'launchId', 'chainId', 'sourceCommit', 'attestationHash', 'contracts', 'assets', 'poolKey', 'network', 'walletAddChain']);
const safePath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':') && path.split('/').every((part) => part && part !== '.' && part !== '..');
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Deployment verification failed: ${message}`);
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validAddress(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value, { strict: false });
}
function validWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateManifest(value: unknown): DeploymentManifest {
  requireValue(isRecord(value), 'configuration must be an object');
  requireValue(Object.keys(value).every((key) => allowedKeys.has(key)), 'unexpected configuration key');
  requireValue(value.version === 1, 'unsupported configuration version');
  requireValue(typeof value.launchId === 'string' && value.launchId.length > 0, 'missing launch identifier');
  requireValue(Number.isSafeInteger(value.chainId) && Number(value.chainId) > 0, 'invalid chain identifier');
  requireValue(typeof value.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(value.sourceCommit), 'invalid source commit');
  requireValue(typeof value.attestationHash === 'string' && hashPattern.test(value.attestationHash), 'invalid attestation hash');
  requireValue(Array.isArray(value.assets) && value.assets.length > 0 && value.assets.length <= 128, 'invalid asset inventory');
  const paths = new Set<string>();
  for (const asset of value.assets) {
    requireValue(isRecord(asset) && safePath(asset.path) && asset.path !== 'imd-deployment.json', 'invalid asset path');
    requireValue(typeof asset.sha256 === 'string' && hashPattern.test(asset.sha256) && !paths.has(asset.path), 'invalid or duplicate asset hash');
    paths.add(asset.path);
  }
  requireValue(paths.has('index.html'), 'entrypoint missing from inventory');
  requireValue(Array.isArray(value.contracts) && value.contracts.length > 0, 'missing contract bindings');
  const names = new Set<string>();
  const addresses = new Set<string>();
  for (const contract of value.contracts) {
    requireValue(isRecord(contract), 'invalid contract binding');
    requireValue(typeof contract.name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(contract.name) && !names.has(contract.name), 'invalid or duplicate contract name');
    requireValue(validAddress(contract.address) && !/^0x0{40}$/i.test(contract.address) && !addresses.has(contract.address.toLowerCase()), 'invalid or duplicate contract address');
    requireValue(typeof contract.abiHash === 'string' && hashPattern.test(contract.abiHash), 'invalid ABI hash');
    requireValue(safePath(contract.abiPath) && paths.has(contract.abiPath), 'ABI is absent from inventory');
    names.add(contract.name);
    addresses.add(contract.address.toLowerCase());
  }
  requireValue(names.has('LaunchToken') && names.has('JobZero'), 'required application contracts are missing');
  const network = value.network;
  requireValue(isRecord(network) && network.chainId === value.chainId, 'vetted network configuration is unavailable or mismatched');
  requireValue(typeof network.name === 'string' && typeof network.testnet === 'boolean', 'invalid network metadata');
  requireValue(Array.isArray(network.rpcUrls) && network.rpcUrls.length > 0 && network.rpcUrls.every(validWebUrl), 'invalid public RPC configuration');
  requireValue(validWebUrl(network.explorer), 'invalid explorer');
  requireValue(isRecord(network.nativeCurrency) && typeof network.nativeCurrency.name === 'string' && typeof network.nativeCurrency.symbol === 'string' && Number.isSafeInteger(network.nativeCurrency.decimals), 'invalid native currency');
  requireValue(isRecord(network.uniswapV4), 'vetted swap configuration is unavailable');
  for (const field of ['poolManager', 'universalRouter', 'quoter', 'stateView', 'positionManager', 'permit2']) {
    requireValue(validAddress(network.uniswapV4[field]), `invalid protocol address: ${field}`);
  }
  const pairTokens = [network.pairToken, ...(Array.isArray(network.otherPairTokens) ? network.otherPairTokens : [])];
  for (const token of pairTokens) {
    requireValue(isRecord(token) && validAddress(token.address) && typeof token.symbol === 'string' && typeof token.name === 'string' && Number.isSafeInteger(token.decimals) && Number(token.decimals) >= 0 && Number(token.decimals) <= 255, 'invalid pair token configuration');
  }
  const pool = value.poolKey;
  requireValue(isRecord(pool) && validAddress(pool.currency0) && validAddress(pool.currency1) && validAddress(pool.hooks), 'attested pool key is unavailable');
  requireValue(BigInt(pool.currency0) < BigInt(pool.currency1), 'pool currencies are not in canonical address order');
  requireValue(Number.isInteger(pool.fee) && Number(pool.fee) >= 0 && Number(pool.fee) <= 0xffffff, 'invalid pool fee');
  requireValue(Number.isInteger(pool.tickSpacing) && Number(pool.tickSpacing) > 0 && Number(pool.tickSpacing) <= 0x7fffff, 'invalid pool tick spacing');
  const launchToken = value.contracts.find((contract) => contract.name === 'LaunchToken');
  requireValue([pool.currency0.toLowerCase(), pool.currency1.toLowerCase()].includes(launchToken.address.toLowerCase()), 'pool does not contain the deployed token');
  if (value.walletAddChain !== undefined) {
    const wallet = value.walletAddChain;
    requireValue(isRecord(wallet) && typeof wallet.chainId === 'string' && /^0x[0-9a-f]+$/i.test(wallet.chainId) && BigInt(wallet.chainId) === BigInt(Number(value.chainId)), 'wallet network does not match deployment');
    requireValue(Array.isArray(wallet.rpcUrls) && wallet.rpcUrls.every(validWebUrl) && typeof wallet.chainName === 'string', 'invalid wallet network settings');
  }
  return value as unknown as DeploymentManifest;
}

async function fetchBytes(url: URL): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Deployment file could not be loaded (${response.status}): ${url.pathname}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  requireValue(bytes.byteLength <= 8_388_608, 'configuration file exceeds size limit');
  return bytes;
}

/** The exported manifest is the sole source of deployment addresses, chain and RPCs. */
export async function loadConfig(base = import.meta.env.BASE_URL): Promise<RuntimeConfig> {
  const baseUrl = new URL(base, window.location.href);
  const bytes = await fetchBytes(new URL('imd-deployment.json', baseUrl));
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
  const contracts = await Promise.all(manifest.contracts.map(async (contract) => {
    const abiBytes = await fetchBytes(new URL(contract.abiPath, baseUrl));
    const asset = manifest.assets.find((entry) => entry.path === contract.abiPath);
    requireValue(asset && sha256(abiBytes).slice(2) === asset.sha256, `${contract.name} ABI file checksum mismatch`);
    const abi: unknown = JSON.parse(new TextDecoder().decode(abiBytes));
    requireValue(Array.isArray(abi), `${contract.name} ABI is not an array`);
    requireValue(keccak256(stringToHex(canonicalJson(abi))).slice(2) === contract.abiHash, `${contract.name} ABI does not match its attested hash`);
    return [contract.name, { ...contract, abi: abi as Abi }] as const;
  }));
  const network = manifest.network;
  return {
    manifest,
    contracts: Object.fromEntries(contracts),
    poolKey: manifest.poolKey,
    network,
    chain: defineChain({
      id: manifest.chainId,
      name: network.name,
      testnet: network.testnet,
      nativeCurrency: network.nativeCurrency,
      rpcUrls: { default: { http: network.rpcUrls } },
      blockExplorers: { default: { name: `${network.name} explorer`, url: network.explorer } },
    }),
  };
}
