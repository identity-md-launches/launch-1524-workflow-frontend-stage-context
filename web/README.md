# JOB #0 frontend

A static React + TypeScript explorer for the deployed JobZero game and TEYO/IMD Uniswap v4 pool. It implements opening runs, explicit TEYO approvals, validated handoffs, queue entry/exit, timeout, claims, owner setup, token transfers and both swap directions. The requested corrupted-explorer design uses locally rendered monospace text, thin borders and restrained red artifacts.

## Install, build and preview

Use Node.js 22.12+ (this worker used Node.js 24.21.0) and npm. All frontend packages and configuration live in this directory.

```sh
cd web
npm ci
npm run typecheck
npm test
npm run build
npm run verify
npm run preview -- --port 4173
```

The build writes the complete export to `../dist/` and then generates `dist/imd-deployment.json`. Serve that directory with a static HTTP server. Vite uses `base: './'`; one page and hash navigation work at a gateway subpath without rewrites. Publishing source, IPFS pinning, DNS/site naming and deployment are outside this worker assignment.

`npm run dev` first builds the verified export, then starts Vite with hot reload. Its development middleware serves the exact generated manifest and ABI JSON from `dist/`; there is no separate development deployment map. `npm run preview` serves the committed production files and is the integration validation target.

## Deployment configuration

`dist/imd-deployment.json` is the sole runtime source of contract addresses, chain ID, public RPCs, ABI paths, network protocol addresses and the exact attested pool key. `src/config.ts` fetches it relative to the current site directory, validates its shape and verifies the referenced raw ABI bytes against both the asset SHA-256 inventory and canonical Keccak ABI hashes. There are no signing keys, private RPC credentials, WalletConnect keys or server dependencies.

`config/deployment.json` and `config/network.json` preserve the supplied handoff for reproducible builds; they are build inputs only. Raw ABIs in `config/abi/` were copied from `docs/abi/<Contract>.json` at the exact deployed source commit and hash checked. Build tooling compares the copies to the pinned commit when available, then hashes every final exported file except the manifest itself. The verifier rejects missing/extra assets, unexpected manifest keys, mismatched deployment/network/pool values and incorrect ABI or asset hashes. See [the handoff evidence](../docs/frontend-handoff.md).

Never edit the generated manifest or export by hand. Any export change requires `npm run build` and `npm run verify` again. A genuinely new deployment needs a new attested handoff and the corresponding implementation-derived ABIs; merely changing an address is insufficient.

## Wallets and transactions

The app supports injected EIP-1193 browser wallets and EIP-6963 wallet discovery, with a selector when multiple wallets are installed. No WalletConnect project ID was provided; no fabricated ID is used. Wallet discovery, switching, account/chain changes, disconnection and user rejection have visible states. An unknown chain response (`4902`, including nested wallet errors) offers `wallet_addEthereumChain` using the exact handoff parameters and then switches again.

Public reads try the configured RPCs, then the connected wallet provider when it is on the correct chain. The client checks the RPC chain ID, nonempty deployed contract code, and token metadata before enabling signing. Reads refresh every five seconds while visible; unchanged blocks avoid repeated game reads. Data older than thirty seconds cannot authorize a transaction. A returned code body is a presence check, not an independent bytecode audit.

Gameplay reads are pinned to one block. Attempts and queue pages have twenty entries (contract limit: one hundred). Loading more freezes that list to its snapshot block and shows an explicit list-refresh control; the main game state continues updating. A new run always resets the list. Bounties and the failure wall load runs newest first in twenty-run pages, with explicit older-history controls and a specific-run claim lookup. No browser-local leaderboard is presented as shared state. All displayed counters come from contract reads; unavailable values remain blank.

Approvals authorize only the displayed amount. Job fees approve JobZero as spender; swap input approves Permit2, followed by Permit2's router allowance, then the swap. Each is an explicit action, conditional on current allowances. All writes are simulated before prompting the wallet and signed by the visitor. Pending requests stay locked until a receipt; unknown confirmations show a recheck control. Replacement/cancellation is distinguished from success. A confirmed receipt triggers new reads before another action.

Swaps read every protocol address from `manifest.network.uniswapV4`, preserve the exact `poolKey`, use read-only quoter simulation and apply the selected 0.1–5% slippage. Quotes expire after thirty seconds. The Universal Router executes command `0x10` with v4 actions `0x060c0f`; ERC-20 input sends zero ETH. Standard and extended swap tuples are supported by the encoder. The actual assigned pool is ERC-20 TEYO/IMD. No live transaction was broadcast during worker validation.

Recipient controls use checksummed Ethereum addresses, copy buttons and explorer links. ENS resolution is not offered because the handed-off network configuration does not supply an ENS resolver; the UI does not suggest unsupported names or embed an independent resolver address. The owner setup panel appears only for the on-chain owner with an unset token, includes a permanence acknowledgement and uses the verified launch token address. USD estimates are unavailable because no approved price source was provided.

## Validation and design

```sh
npm run typecheck
npm test
npm run build
npm run verify
# Browser tooling is deliberately installed outside the submission:
npm install --prefix /tmp/jobzero-browser-tools playwright
/tmp/jobzero-browser-tools/node_modules/.bin/playwright install chromium webkit
IMD_PLAYWRIGHT=/tmp/jobzero-browser-tools/node_modules/playwright/index.mjs npm run test:browser
# From repository root, for the pinned review probe while assignment inputs exist:
IMD_PLAYWRIGHT=/tmp/jobzero-browser-tools/node_modules/playwright/index.mjs node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste
```

The browser suite serves the final export under `/preview/`, injects a mock wallet and intercepts configured RPC requests. It decodes real ABI calldata to check the intended actions and refuses unintended network calls. Mock addresses/balances are confined to test fixtures and never enter the production bundle or deployment configuration. Browser engines may require operating-system libraries; worker-specific details and actual results are in [frontend validation](../docs/frontend-validation.md).

[Design documentation](../docs/DESIGN.md) describes the final tokens, components and responsive behavior. It lives under `docs/` because the assignment explicitly allows only `web/**`, `dist/**` and `docs/**`; the separate root `DESIGN.md` criterion conflicts with that write budget. The sole ignore-file change is the explicitly allowed `web/.gitignore`, covering generated dependencies/caches recursively. No root configuration or deployed contract source was modified.

Relative Open Graph paths are intentional until the publisher assigns a live gateway/domain. The title, favicon, description, OG title and local share image ship with the export. The worker report is validation evidence, not independent certification; live-chain behavior and publication checks are separately identified there.
