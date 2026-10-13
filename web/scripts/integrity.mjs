import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, keccak256, stringToHex } from 'viem';

export const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(webRoot, '..');
export const exportRoot = join(repoRoot, 'dist');
export const hash256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const abiHash = (abi) => keccak256(stringToHex(canonical(abi))).slice(2);
export const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const safePath = (path) => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.includes(':') && path.split('/').every((part) => part && part !== '.' && part !== '..');
const hashPattern = /^[0-9a-f]{64}$/;

export async function readInputs() {
  const deployment = JSON.parse(await readFile(join(webRoot, 'config/deployment.json'), 'utf8'));
  const network = JSON.parse(await readFile(join(webRoot, 'config/network.json'), 'utf8'));
  assert(deployment.version === 1, 'Unsupported deployment version');
  assert(typeof deployment.launchId === 'string' && deployment.launchId.length > 0, 'Missing launch ID');
  assert(/^[0-9a-f]{40}$/.test(deployment.sourceCommit), 'Invalid deployed source commit');
  assert(hashPattern.test(deployment.attestationHash), 'Invalid attestation hash');
  assert(Number.isSafeInteger(deployment.chainId) && deployment.chainId > 0, 'Invalid chain ID');
  assert(network.network?.chainId === deployment.chainId, 'Network does not match deployed chain');
  assert(Array.isArray(network.network.rpcUrls) && network.network.rpcUrls.length > 0, 'Missing vetted RPC URL');
  assert(Array.isArray(deployment.contracts) && deployment.contracts.length > 0, 'Missing deployed contracts');
  const names = new Set();
  for (const contract of deployment.contracts) {
    assert(/^[A-Za-z][A-Za-z0-9_]*$/.test(contract.name) && !names.has(contract.name), 'Invalid or duplicate contract name');
    names.add(contract.name);
    assert(isAddress(contract.address, { strict: false }) && !/^0x0{40}$/i.test(contract.address), `Invalid ${contract.name} address`);
    assert(hashPattern.test(contract.abiHash), `Invalid ${contract.name} ABI hash`);
  }
  // When the worker inputs are present, require the preserved build inputs to remain identical.
  for (const [name, saved] of [['deployment', deployment], ['network', network]]) {
    try {
      const pinned = JSON.parse(await readFile(join(repoRoot, `.imd/reads/${name}.json`), 'utf8'));
      assert(canonical(saved) === canonical(pinned), `${name} input differs from the pinned handoff`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { deployment, network };
}

export async function readVerifiedAbis(deployment) {
  const result = [];
  for (const contract of deployment.contracts) {
    const bytes = await readFile(join(webRoot, 'config/abi', `${contract.name}.json`));
    const abi = JSON.parse(bytes.toString('utf8'));
    assert(Array.isArray(abi), `${contract.name} ABI must be a raw JSON array`);
    assert(abiHash(abi) === contract.abiHash, `${contract.name} canonical Keccak ABI hash mismatch`);
    let pinned;
    try {
      pinned = execFileSync('git', ['show', `${deployment.sourceCommit}:docs/abi/${contract.name}.json`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // The published source may be a shallow checkout. Preserved, hash-bound ABI bytes
      // make that checkout reproducible without fetching or changing contract source.
    }
    if (pinned) assert(bytes.equals(pinned), `${contract.name} ABI differs from the exact deployed source commit`);
    result.push({ contract, bytes, abiPath: `abi/${contract.name}.json`, sourceCommitChecked: !!pinned });
  }
  return result;
}

export async function inventory(directory = exportRoot) {
  const found = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const fullPath = join(path, entry.name);
      assert(!entry.isSymbolicLink(), `Export must not contain a symbolic link: ${fullPath}`);
      if (entry.isDirectory()) { await visit(fullPath); continue; }
      assert(entry.isFile(), `Unexpected export entry: ${fullPath}`);
      const assetPath = relative(directory, fullPath).split(sep).join('/');
      if (assetPath === 'imd-deployment.json') continue;
      assert(safePath(assetPath), `Unsafe exported asset path: ${assetPath}`);
      const info = await lstat(fullPath);
      assert(info.size <= 8_388_608, `Asset exceeds 8 MiB: ${assetPath}`);
      found.push({ path: assetPath, sha256: hash256(await readFile(fullPath)), size: info.size });
    }
  }
  await visit(directory);
  found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert(found.length <= 128, 'Export contains more than 128 assets');
  assert(found.some((entry) => entry.path === 'index.html'), 'Missing dist/index.html');
  const totalBytes = found.reduce((sum, entry) => sum + entry.size, 0);
  assert(totalBytes < 32 * 1024 * 1024, 'Export exceeds the publication response budget');
  return { assets: found.map(({ path, sha256 }) => ({ path, sha256 })), totalBytes };
}

export function manifestFields(deployment, network) {
  return {
    version: 1,
    launchId: deployment.launchId,
    chainId: deployment.chainId,
    sourceCommit: deployment.sourceCommit,
    attestationHash: deployment.attestationHash,
    contracts: deployment.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash, abiPath: `abi/${name}.json` })),
    ...(deployment.poolKey ? { poolKey: deployment.poolKey } : {}),
    network: network.network,
    ...(network.walletAddChain ? { walletAddChain: network.walletAddChain } : {}),
  };
}
