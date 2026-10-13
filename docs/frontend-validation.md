# JOB #0 frontend validation

The mobile full-precision approval revision is documented in [frontend-revision.md](frontend-revision.md), including the current export hash and 42 browser results. The initial-delivery evidence below is retained as historical evidence; the revision report supersedes its final-export measurements and check counts.

This is worker-produced evidence for the static frontend. It is not an independent contract audit or the control plane's publication verification. The frontend is built in `web/` and exported to `dist/`; no contract source or deployment was changed. All interaction transactions described below use intercepted JSON-RPC and a deterministic browser-wallet fixture. No funded wallet, signature, approval or swap was broadcast to Ethereum.

## Scope and consequential assumptions

- One static explorer page, including JobZero gameplay, the onchain queue/history/claims and the attested TEYO/IMD Uniswap v4 pool.
- Ethereum, deployed contracts, pool key and protocol addresses come from the deployment/network handoff. The exported manifest is the app's runtime configuration; implementation ABI files are loaded from its relative paths.
- The requested black/white monospace explorer, uppercase data labels, red failure accents and restrained verification flicker take priority over the guide's default preferences for sentence case and proportional prose. The exact supplied hero text takes priority over the six-word marketing-headline guideline.
- Public RPCs and an injected browser wallet suffice. No WalletConnect project ID or private RPC credential was supplied or invented.
- A relative Open Graph image is appropriate until the publisher assigns a URL. Browser tests use a gateway-style `/preview/` path.
- The task's explicit writable-path budget excludes repository-root `DESIGN.md`. The implementation-derived design document is delivered at `docs/DESIGN.md`, preserving the higher-priority path restriction.

## Reproducible checks

Install and build from `web/` using the committed lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify
```

Browser harness: `web/tests/browser.mjs`; RPC/wallet fixture: `web/tests/mock-rpc.mjs`. The harness starts and closes its own bounded foreground static server, serves the production export at `/preview/`, blocks all non-configured external origins and intercepts every RPC request. The harness first copies the current export into scratch for an immutable test snapshot. The mock decodes actual deployment ABI calldata, returns encoded read responses and records transaction targets, amounts and protocol calldata. Synthetic wallet addresses exist only in the test fixture and never enter deployment configuration or the export.

Playwright and axe are optional external validation tools, intentionally not vendored or included in the application bundle:

```sh
npm install --prefix /tmp/jobzero-browser-tools playwright@1.58.2 @axe-core/playwright@4.11.1
PLAYWRIGHT_BROWSERS_PATH=/tmp/jobzero-browser-binaries /tmp/jobzero-browser-tools/node_modules/.bin/playwright install chromium webkit
IMD_PLAYWRIGHT=/tmp/jobzero-browser-tools/node_modules/playwright/index.mjs \
IMD_AXE=/tmp/jobzero-browser-tools/node_modules/@axe-core/playwright/dist/index.mjs \
PLAYWRIGHT_BROWSERS_PATH=/tmp/jobzero-browser-binaries npm run test:browser
```

On this worker WebKit shared libraries were downloaded as Ubuntu packages and extracted under `/tmp/jobzero-webkit-libs`, without system installation. The temporary MiniBrowser launch scripts were adjusted to preserve `LD_LIBRARY_PATH`; the browser ran with that directory and `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` because Playwright's ldconfig cache probe cannot see extracted libraries. This workaround affects tooling only, not source or export. On a normally provisioned machine, Playwright's regular browser dependencies suffice.

The pinned design probe is run from the repository root:

```sh
IMD_PLAYWRIGHT=/tmp/jobzero-browser-tools/node_modules/playwright/index.mjs \
PLAYWRIGHT_BROWSERS_PATH=/tmp/jobzero-browser-binaries \
node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste
```

The pinned `.imd/reads/` inputs and scratch output are removed before submission. Probe script provenance and thresholds are therefore recorded here, while the application-owned browser harness remains reproducible after delivery.

## Results

| Check | Result |
| --- | --- |
| Production build | Passed; Vite exports relative assets and generates the final manifest after bundling. |
| TypeScript check | Passed; final production build also runs `tsc --noEmit`. |
| Development serving | Vite smoke check passed: hot-reloaded source and byte-identical manifest/ABI responses from the verified export. |
| Unit/integrity tests | 20/20 test groups passed (7 game, 10 swap, 3 integrity). |
| Chromium + WebKit interactions | 38/38 passed (19 cases per engine), Chromium 145.0.7632.6 and WebKit 26.0; final manifest SHA-256 `37c46f082f246f24ddfd6f8c33ce78e8ae14b8dcbcb93aed2e4c16b0d880f4f3`. |
| Accessibility | axe WCAG 2/2.1/2.2 A/AA scan: zero violations in the rendered connected-worker state in both engines. |
| Reflow | No horizontal overflow at 320, 390, 768 or 1440px, including the full-address wallet disclosure at 320px. |
| Metadata | Title, favicon, description, `og:title` and local `og:image` present; share image is 1200×630. |
| Pinned taste@1 | 13/16 raw checks pass; three explained brief exceptions/false positives below. No unresolved substantive layout/accessibility finding. |
| Public-chain reads | Verified read-only through the configured publicnode endpoint; secondary drpc endpoint returned HTTP 500. |
| Real transactions | Not performed or authorized. |

The browser suite covers connection/no-provider/rejection, unknown-chain 4902 → add → switch, exact JobZero approvals/open, manual recipient validation/handoff, queue one-tap handoff, queue entry/exit/no rejoin, expired timeout, past-run claims and failed-worker exclusion, owner-only setup, contract reverts/retry, transfer validation and account changes, missing code/RPC failures, 25-entry queue/attempt pagination, retained block snapshots, 25-run history, direct bounty lookup and a delayed lookup returning after the wallet changes. Swap cases exercise quotes without transactions, exact ERC20 approval, Permit2 approval, router execution with the complete attested pool key, minimum output and zero native value for the IMD pair; valid existing approvals skip redundant transactions. Editing amount/slippage invalidates quotes. Pending approvals remain locked while the receipt is unavailable.

All tests operate against a frozen copy of the built export so a subsequent build cannot alter the page midway through a test. The final manifest SHA-256 is recorded in `docs/evidence/browser-results.json`, together with per-case results and first-screen measurements.

## Six-domain Better Interface review

The reviewer read the pinned workflow and all six domain core sections before implementation review, then the documentation method. Supporting checks are consolidated here, rather than treating every domain as a separate redesign.

| Domain | Coverage | Evidence and limitations |
| --- | --- | --- |
| Accessibility | Checked | Native buttons, links, details and bound labels; one main landmark, skip link, contextual alerts/status, invalid-field descriptions and 44px primary controls. Keyboard navigation and an actual focused-state screenshot were inspected; both engines pass axe. Reduced motion stops both ongoing effects. No physical device or screen-reader session was run; automated checks do not establish full WCAG compliance. |
| Layout | Checked | Actual export at 320/390/768/1440px; mobile first screen, large balances, full addresses, open wallet disclosure, stacked forms, list pagination and fixed status bar. Desktop text enlarged to 200% without horizontal overflow. Browser-native 200% zoom and an RTL mirror were not tested; this release is English only. |
| Writing | Checked | Action labels correspond to signatures; costs, fee split, irreversible setup, queue burn/no rejoin, failed-worker exclusion and ETH gas are explained by the controls. Empty/error states offer a next action. Unset configuration, unavailable reads and unavailable USD data are stated honestly. Requested story copy is retained. |
| Typography | Checked | Six authored sizes, two weights, one system monospace stack; headline is heaviest, numeric data is tabular, inputs stay 16px on phones, addresses and exact token values wrap. Fonts are system-dependent; no native iOS font rendering session was performed. |
| Colors | Checked | Semantic tokens are documented in `docs/DESIGN.md`. Probe measured all text above 4.5:1 (3:1 large); representative exact pairs are recorded there. Deliberate dark-only appearance, no absent light-theme claim. Disabled controls are distinct and errors also carry text. Forced-colors CSS was read but not tested in an OS high-contrast session. |
| UI details | Checked | Disconnected, wrong-chain, owner-unset, empty, running-worker, expired, loading, approval, pending, confirmed, rejected, revert, retry and stale-response states. Borders form the flat hierarchy; no border/shadow stacks or nested cards. Reduced motion and pause controls are implemented. Slow-motion animation-panel replay was not performed. |

## Findings, corrections and rechecks

| Severity / domain | Source location | Finding and correction | Recheck |
| --- | --- | --- | --- |
| High / layout | `web/src/styles.css:231`, `web/src/styles.css:240` | At 390×844 the first worker handoff button ended at 850.98px, below the screen and behind the status bar. Mobile deadline/current-worker data now share a row; hero/job-body gaps were reduced without removing data. | Final Chromium/WebKit handoff control is fully above the live bar; measured positions are in browser-results.json. |
| Medium / structure | `web/src/App.tsx:257`, `web/src/SwapPanel.tsx:328` | The first composition wrapped a complete Trade section in a second same-ID section. The outer wrapper was removed, leaving one heading/section/panel. | Probe: no nested cards; axe: no duplicate-ID or structure violation. |
| Medium / action clarity | `web/src/App.tsx:231` | A second prominent queue approval duplicated the main next-action control. The duplicate was removed while preserving queue rows and their worker-only handoff actions. | Main queue entry/exit and one-tap row handoff both pass in both engines. |
| Medium / writing | `web/src/game.ts:67` (`addressIssue`) | A validation hint offered ENS names although the control validates hexadecimal Ethereum addresses. The hint now asks for a valid Ethereum address. | Invalid/self/repeat-recipient browser cases pass; no unsupported ENS promise. |
| High / stale state | `web/src/App.tsx:94`, `web/src/App.tsx:122`, `web/src/App.tsx:144`, `web/src/App.tsx:176` | Polling could collapse expanded lists, and delayed history/recipient/bounty responses could publish after context changed. Expanded lists now retain an identified block snapshot and explicit refresh; version/context guards discard stale responses. | 25-row/25-run pagination, explicit refresh, one-tap handoff and delayed lookup after wallet change pass in both engines. |
| Medium / contract errors | `web/src/SwapPanel.tsx:29`, `web/src/SwapPanel.tsx:63` | Live sell quoting returned nested Uniswap `UnexpectedRevertBytes(NotEnoughLiquidity(poolId))`. The quoter/router error decoder now shows a plain liquidity message and leaves signing unavailable. | Error decoder unit coverage passes; read-only RPC evidence preserves the actual revert. Real swaps were not sent. |
| Medium / unknown confirmation | `web/src/useGame.ts:102`, `web/src/SwapPanel.tsx:263`, `web/src/SwapPanel.tsx:284` | A returned transaction hash does not prove execution. The final flow retains the submitted/replacement hash and lock when confirmation is unavailable, offers a recheck and distinguishes cancelled/repriced replacements. | Unit replacement classification and browser pending-approval locking pass. A real mempool replacement was not performed. |
| High / error recovery | `web/src/game.ts:48`, `web/src/game.ts:59` | `BaseError.walk` may return null when no rejection cause exists; reading `.code` could throw during error handling. Optional access now returns the safe actionable fallback. | Unit cases cover null/unrelated errors and real custom errors; browser rejection/revert/retry cases pass. |
| High / refreshed state | `web/src/useGame.ts:22`, `web/src/useGame.ts:63` | An in-flight poll could cause a receipt-triggered refresh to disappear, while an older account request could unlock a newer request. Forced refreshes now queue behind the current poll, and only their own request identity can release the lock. | Source control flow reviewed; browser approval/open/confirmation and account-change flows pass. The exact same-millisecond poll/receipt interleaving was not separately forced. |

Initial harness failures were repaired in the test fixture: ERC20 simulations return their required boolean, transaction-by-hash JSON excludes decoded bigint argument fields, and screenshots wait for the connected read to settle. These were fixture defects, not application findings. The final suite has no pending fixture failures.

## Pinned design-probe interpretation

The final raw probe result is preserved in `docs/evidence/taste-summary.json`. Its three non-passing heuristics are deliberately retained and are not hidden as passes:

- **casing**: the brief explicitly requires “uppercase labels” and a “VERIFICATION FAILED” stamp. Measured uppercase labels are those requested explorer data/status elements.
- **type-faces**: the brief explicitly requires “white monospace text.” The app uses one family stack and two weights; the raw failure is specifically the general guide's monospace-prose preference.
- **eyebrows**: the heuristic classifies the top-left `imd` home brand and metric `<dt>` labels above their numbers as kicker labels. Screenshot/source inspection confirms they are the required header convention and labelled data, not extra small headings above section titles. Removing the labels would harm comprehension.

The actual layout, contrast, targets, tracking, size count, glyphs, slogan count, repetition, copy budget, surface treatment, reduced motion and sharing checks pass. The one visual idea is an IMD explorer record corrupted by a sparse red verification stamp; it does not compete with background art, gradients or marketing cards.

## Live-chain observation and remaining limits

`docs/frontend-live-reads.json` records the exact read-only responses. At Ethereum block 26181922, the publicnode endpoint reported chain ID 1, nonempty deployed code (LaunchToken 1,722 bytes, JobZero 8,286 bytes), and token metadata Teyo / TEYO / 18. JobZero reported owner `0xE8BFF6587b2481008AE36b26599B9b9530669c35`, token unset, no open run, current run 0 and total burned 0. The zero token is an observed onchain unset value, not an invented deployment address. The app correctly renders Awaiting setup; only that connected owner can use the permanent Set TEYO panel.

The configured Uniswap quoter returned an output of `392515.152799552868130412 TEYO` for a simulated exact input of 1 IMD. Sell quotes for 0.000001, 1, 1,000 and 1,000,000 TEYO returned `NotEnoughLiquidity` wrapped by `UnexpectedRevertBytes`; stateView reported active liquidity 0 at tick -128999 for the attested pool ID. This is observed pool state at that time, not a guarantee about future liquidity or a claim that a funded swap would succeed. Quotes were `eth_call` only. The secondary configured drpc endpoint returned HTTP 500 to the batch inspection; publicnode served both app reads and the successful quote.

No owner setup, funded approval, opening, handoff, timeout, payout, transfer or swap was broadcast. Mocked state transitions check frontend behavior and calldata, not deployed-contract economic correctness. Physical iOS/Android devices, hardware wallets, wallet extension implementations, ENS resolution and live transaction replacement were not tested. The app supports browser-wallet/EIP-6963 discovery without a WalletConnect project ID. Native screen readers, browser-native zoom and OS forced colors remain unperformed checks.

Vite emits a nonblocking warning for the main minified JavaScript chunk above 500 kB (approximately 175 kB gzip); the complete export remains far below the assignment's limits. All runtime assets are local. The share image URL remains relative until the publisher supplies a hostname. IPFS pinning, named entrypoints and control-plane immutable-asset/RPC checks run after source delivery and are not claimed as completed here.

The final 390px handoff button ended at 768.59375px in Chromium and 768px in WebKit, above the fixed live bar at 805px. The probe counted 24 first-screen prose words at 390px and 33 at 1440px. Both final screenshot sets were inspected after the last build.

## Evidence and completion

- `docs/evidence/live-390.png`, `live-1440.png`: final production interface with real read-only network state, disconnected wallet, pending owner setup.
- `docs/evidence/worker-390-mocked.png`, `worker-1440-mocked.png`: production UI with explicitly mocked running-worker data; these are interaction/layout evidence, not public-chain activity.
- `docs/evidence/keyboard-focus-390.png`: keyboard focus in the mocked worker state.
- `docs/evidence/browser-results.json`, `taste-summary.json`: compact machine-readable outcomes.
- `docs/frontend-live-reads.json`: timestamped public-network results and failures.

Complete for the stated frontend scope. The final export passed build/typecheck, all 20 unit/integrity test groups and all 38 Chromium/WebKit cases. The path-budget exception for root DESIGN.md and the unperformed live-chain/device checks above remain explicit. This is worker evidence, not independent certification or publication verification.

The worker could not create a Git commit because repository Git metadata is mounted read-only: `git add` failed creating `.git/index.lock` with `Read-only file system`. Source, export and evidence remain complete in the workspace for submission; this is a delivery-environment limitation, not a frontend validation failure.
