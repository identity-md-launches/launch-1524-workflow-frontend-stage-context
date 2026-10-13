# Frontend deployment and asset integrity

The deployed source is commit `80049f743e5c4a5f6ae0712ea24c1b6b8d8d9705`, launch `67c8a7ac-9551-4b19-aca5-beb9a6033b36`, on Ethereum (chain 1). The supplied attestation hash is `fd12be4373160ddf552c30c85722fb7ad93dfabcd839631a35eec35914b86cd7`.

`web/config/deployment.json` and `web/config/network.json` preserve the supplied build inputs unchanged. They are build inputs only; the browser does not import either. `dist/imd-deployment.json` is the browser's single runtime source for deployed addresses, chain, network, pool key and ABI references. Its network and optional wallet-add-chain blocks are copied unchanged, and its pool key preserves the initialization guard hook. No inferred router, replacement hook, extra deployment or private RPC credential is included.

## ABI provenance

The worker extracted the raw JSON arrays with `git show <sourceCommit>:docs/abi/<Contract>.json`. Preserved copies in `web/config/abi/` make the frontend rebuildable even in a later shallow checkout without the deployment commit. Each build verifies these copies against their canonical Keccak hashes and, when the git object is available, against its exact raw bytes. With pinned worker inputs present, the build also rejects any difference between them and the preserved JSON inputs.

| Contract | ABI bytes | Verified canonical Keccak-256 |
| --- | ---: | --- |
| LaunchToken | 5,715 | `38880b8e56d42ce900f744a7908c7139632a49f1c3f33385c64ceaed29d37bee` |
| JobZero | 17,958 | `e2b15d872457761a7290741f6063e471b54a06d8a1550e05271c6d695d68d51e` |

Canonical encoding recursively sorts object keys, preserves array order and JSON values, and uses compact UTF-8 JSON. The hash is Keccak-256, represented as lowercase hex without `0x`. Both ABI hashes and raw source-commit byte comparisons passed on the worker. The original deployed Solidity sources and ABIs remain unchanged.

## Build and verification

From the repository root:

```sh
npm --prefix web ci
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run verify
```

Vite writes the static export into root `dist/` with a relative base. `web/scripts/build-manifest.mjs` runs after Vite, writes the verified raw ABI JSON files, inventories every exported file except the manifest itself, and writes `dist/imd-deployment.json`. Each inventory item includes the SHA-256 of the exact exported bytes. Any export change requires rebuilding this manifest.

`web/scripts/verify-export.mjs` independently inventories the current export and checks the complete manifest against the preserved handoff: exact contract set, names, addresses, ABI hashes, pool key, network blocks, allowed top-level schema, current asset bytes and ABI contents. It rejects symlinks, unsafe paths, files exceeding 8 MiB, more than 128 assets, missing entrypoint, missing required page metadata and root-absolute HTML asset URLs. The full source submission has a separate 8 MiB budget; the export budget does not increase that limit.

The browser's `web/src/config.ts` loads this manifest and every referenced ABI from the same relative static directory. It rejects malformed configuration, unexpected top-level keys, missing/duplicate bindings, chain mismatch, unsafe asset paths, invalid protocol addresses, ABI file SHA-256 mismatch and canonical ABI hash mismatch. Only the resulting configuration is used to construct the chain and contract bindings. Static hosting requires no backend or route rewrites.

## Integrity test evidence

`web/scripts/integrity.test.mjs` passed three test groups on the worker:

1. Preserved ABI hashes match the handoff and the pinned implementation exports.
2. The exact manifest is accepted; an extra router key, altered network chain, path traversal, recursive manifest inventory, duplicate inventory entry, credentialed RPC, invalid pool ordering and duplicate contract name are rejected.
3. The actual runtime loader fetches the manifest and ABIs below a mocked gateway subpath, preserves the network and pool key, and refuses both changed ABI bytes and changed ABI content whose asset SHA-256 was recomputed.

To run this focused check with the installed frontend test loader:

```sh
cd web
npx tsx --test scripts/integrity.test.mjs
```

These checks bind local artifacts to the supplied handoff. They do not independently authenticate an attestation signature, publish to IPFS, certify a named gateway, or prove a wallet transaction succeeds on the live chain. Final build/browser/interaction observations and live-chain limitations are recorded separately in the frontend validation documentation. No contract deployment or real transaction is authorized or performed by these integrity scripts.
