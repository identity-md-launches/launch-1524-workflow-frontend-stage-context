import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportRoot, readInputs, readVerifiedAbis, inventory, manifestFields } from './integrity.mjs';

const { deployment, network } = await readInputs();
const abis = await readVerifiedAbis(deployment);
await mkdir(join(exportRoot, 'abi'), { recursive: true });
for (const { abiPath, bytes } of abis) await writeFile(join(exportRoot, abiPath), bytes);
const { assets, totalBytes } = await inventory();
await writeFile(join(exportRoot, 'imd-deployment.json'), `${JSON.stringify({ ...manifestFields(deployment, network), assets }, null, 2)}\n`);
console.log(`Manifest: ${assets.length} assets, ${totalBytes.toLocaleString('en-US')} bytes; ${abis.length} attested ABIs verified.`);
console.log(`Pinned source bytes checked: ${abis.filter((abi) => abi.sourceCommitChecked).length}/${abis.length}.`);
