import assert from 'node:assert/strict';
import test from 'node:test';
import { readInputs, readVerifiedAbis, abiHash, hash256, manifestFields, safePath } from './integrity.mjs';
import { canonicalJson, loadConfig, validateManifest } from '../src/config.ts';

const { deployment, network } = await readInputs();
const abis = await readVerifiedAbis(deployment);
function fixture() {
  return {
    ...manifestFields(deployment, network),
    assets: [
      { path: 'index.html', sha256: hash256('<!doctype html>') },
      ...abis.map(({ abiPath, bytes }) => ({ path: abiPath, sha256: hash256(bytes) })),
    ],
  };
}

test('implementation ABI bytes match the source commit and attested canonical hashes', () => {
  for (const { contract, bytes } of abis) {
    const abi = JSON.parse(bytes);
    assert.equal(abiHash(abi), contract.abiHash);
    assert.equal(abiHash(JSON.parse(canonicalJson(abi))), contract.abiHash);
  }
});

test('manifest accepts exact handoff and rejects altered schema, chain and paths', () => {
  assert.equal(validateManifest(fixture()).poolKey.hooks, deployment.poolKey.hooks);
  for (const mutation of [
    (value) => { value.router = network.network.uniswapV4.universalRouter; },
    (value) => { value.network.chainId += 1; },
    (value) => { value.contracts[0].abiPath = '../outside.json'; },
    (value) => { value.assets[0].path = 'imd-deployment.json'; },
    (value) => { value.assets.push(value.assets[0]); },
    (value) => { value.network.rpcUrls = ['https://secret:password@rpc.example']; },
    (value) => { value.poolKey.currency0 = value.poolKey.currency1; },
    (value) => { value.contracts[1].name = value.contracts[0].name; },
  ]) {
    const changed = structuredClone(fixture());
    mutation(changed);
    assert.throws(() => validateManifest(changed), /Deployment verification failed/);
  }
  for (const path of ['../secret', '/index.html', 'https://example.test/a', 'abi\\A.json', 'abi//A.json', './index.html']) assert.equal(safePath(path), false);
});

test('runtime loads manifest and hash-bound ABI files below a gateway subpath', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const files = new Map(abis.map(({ abiPath, bytes }) => [abiPath, bytes]));
  const visited = [];
  globalThis.window = { location: { href: 'https://example.test/ipfs/example-cid/index.html' } };
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    visited.push(path);
    assert.ok(path.startsWith('/ipfs/example-cid/'));
    const key = path.slice('/ipfs/example-cid/'.length);
    const bytes = key === 'imd-deployment.json' ? JSON.stringify(fixture()) : files.get(key);
    return new Response(bytes, { status: bytes ? 200 : 404 });
  };
  try {
    const config = await loadConfig('./');
    assert.equal(config.chain.id, deployment.chainId);
    assert.equal(config.contracts.JobZero.address, deployment.contracts.find(({ name }) => name === 'JobZero').address);
    assert.deepEqual(config.network, network.network);
    assert.deepEqual(config.poolKey, deployment.poolKey);
    assert.equal(visited.length, deployment.contracts.length + 1);

    const first = abis[0];
    files.set(first.abiPath, Buffer.concat([first.bytes, Buffer.from('\n')]));
    await assert.rejects(() => loadConfig('./'), /ABI file checksum mismatch/);

    const changedAbi = JSON.parse(first.bytes);
    changedAbi.pop();
    files.set(first.abiPath, Buffer.from(JSON.stringify(changedAbi)));
    const tampered = fixture();
    tampered.assets.find(({ path }) => path === first.abiPath).sha256 = hash256(files.get(first.abiPath));
    globalThis.fetch = async (url) => {
      const key = new URL(url).pathname.slice('/ipfs/example-cid/'.length);
      return new Response(key === 'imd-deployment.json' ? JSON.stringify(tampered) : files.get(key));
    };
    await assert.rejects(() => loadConfig('./'), /ABI does not match its attested hash/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
