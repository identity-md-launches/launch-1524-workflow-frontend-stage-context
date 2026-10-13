import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { abiHash, assert, canonical, exportRoot, inventory, manifestFields, readInputs, readVerifiedAbis } from './integrity.mjs';

const { deployment, network } = await readInputs();
await readVerifiedAbis(deployment);
const manifest = JSON.parse(await readFile(join(exportRoot, 'imd-deployment.json'), 'utf8'));
const { assets, totalBytes } = await inventory();
const expected = { ...manifestFields(deployment, network), assets };
assert(canonical(manifest) === canonical(expected), 'Export manifest differs from the exact handoff, network, ABI paths or current asset bytes');
for (const contract of manifest.contracts) {
  const abi = JSON.parse(await readFile(join(exportRoot, contract.abiPath), 'utf8'));
  assert(Array.isArray(abi), `${contract.name}: ABI must be a raw array`);
  assert(abiHash(abi) === contract.abiHash, `${contract.name}: exported ABI hash mismatch`);
}
const html = await readFile(join(exportRoot, 'index.html'), 'utf8');
assert(!/(?:src|href)=["']\/(?!\/)/.test(html), 'Root-absolute asset path breaks gateway subpath hosting');
for (const requirement of ['<title>', 'rel="icon"', 'name="description"', 'property="og:title"', 'property="og:image"']) {
  assert(html.includes(requirement), `Missing required page metadata: ${requirement}`);
}
console.log(`Export verified: exact deployment/network/pool, ${manifest.contracts.length} canonical ABI hashes, ${assets.length} SHA-256 asset hashes, ${totalBytes.toLocaleString('en-US')} bytes.`);
