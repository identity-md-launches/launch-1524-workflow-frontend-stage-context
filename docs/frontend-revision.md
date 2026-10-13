# Full-precision mobile approval revision

Finding `7f22d638bae33086620c551f66da3dfcc476fd50d1754a9ac2778bc61dc7b43d` was reproduced and fixed. Production changes are limited to `web/src/App.tsx:173` (“Approve TEYO”) and `web/src/styles.css:253` (mobile assignment gap: 6px). Transaction construction, precise amount formatting, deployment configuration and dependencies retain their accepted implementation.

## Reproduction and result

The new `worker-full-precision-approval-7` and `worker-full-precision-approval-15` browser cases use the existing configured-RPC/wallet fixture, connected as the current worker with an active deadline, token configured and zero allowance. Starting at a 1,000 TEYO fee and 10,000 TEYO bounty, they apply `bounty += fee - fee / 2` and `fee += fee * 3 / 100` using bigint arithmetic, once per handoff. The resulting fifteen-handoff fee is `1557967416600764580520` base units and bounty is `19299456943346076342038` base units (16 attempts).

Measurements are taken at 390×844 and scrollY=0, before typing a recipient:

| State | Original Chromium button bottom | Revised Chromium / WebKit button bottom | Live bar top |
| --- | ---: | ---: | ---: |
| Seven handoffs | 816.59375px | 796.59375px | 805px |
| Fifteen handoffs | 836.59375px | 796.59375px | 805px |

Both revised buttons are 44px high. The whole action is above the fixed bar. Exact fee text remains in both the explanation and next-handoff metric; exact bounty text remains in the bounty metric. Tests check these visible strings at 320, 390 and 1440px, with no horizontal overflow, then verify the approval's spender and exact bigint amount and complete the handoff using mock transactions. Before/after 390px screenshots were visually inspected; the existing 320px and desktop rendered checks also ran.

## Validation

- `npm run typecheck`, `npm test`, `npm run build`, `npm run verify`: passed; 20/20 unit/integrity tests, including both ABIs compared to the pinned source and handoff.
- Production export browser suite: 42/42 cases passed, 21 each in Chromium 156.0.8078.4 and WebKit 27.2. Includes the two new regressions plus the existing wallet, wrong-chain, rejection, approvals, gameplay, history, transfer and swap cases. No uncaught JavaScript errors or missing local resources at `/preview/`.
- Axe 4.13.0: zero WCAG 2/2.1/2.2 A/AA violations in the connected-worker state in each engine. Existing keyboard, reduced-motion, large-balance, open-wallet disclosure and 320/390/768/1440 reflow checks pass.
- Final manifest SHA-256: `4fd751d9b83585829a8d78f3973fd844fe9f836812b1ac9d466872446519e6a3`. All eight declared assets verify; export size is 676,405 bytes excluding the manifest, 679,910 including it. The final bundle was built before browser validation, and no exported file changed afterward.
- Pinned `taste@1`, run with `--offline`: 12/16 raw checks pass, including layout, targets, contrast, motion and metadata. Casing and monospace follow the brief. The eyebrow heuristic flags the home brand and metric labels; these remain functional labels. The additional offline glyph flag is the unknown queue count `— online`, not an authored prose em dash. None requires a change for this finding.

Reproduce after the normal install/build steps in `web/README.md`:

```sh
# Run from web/ with Playwright installed outside the submission.
IMD_PLAYWRIGHT=/tmp/jobzero-revision-tools/node_modules/playwright/index.mjs \
PLAYWRIGHT_BROWSERS_PATH=/tmp/jobzero-revision-browsers \
BROWSER_CASE=worker-full-precision npm run test:browser
# Omit BROWSER_CASE for the complete suite; set IMD_AXE for the accessibility scan.
```

This worker installed Playwright 1.64.0 and axe 4.13.0 under `/tmp/jobzero-revision-tools`, with browser binaries under `/tmp/jobzero-revision-browsers`. npm used a writable `/tmp/jobzero-revision-npm` cache because its default cache was read-only. WebKit used the existing extracted libraries at `/tmp/imd-review-webkit-deps/root/usr/lib/x86_64-linux-gnu` via `LD_LIBRARY_PATH`, with its temporary MiniBrowser launch scripts preserving that path. `__EGL_VENDOR_LIBRARY_FILENAMES` pointed at that extracted root's `usr/share/glvnd/egl_vendor.d/50_mesa.json`, and `LIBGL_ALWAYS_SOFTWARE=1` enabled rendering. `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` bypassed the system-library inventory check; actual browser launch and all cases passed. These are local tooling settings, not application changes.

From the repository root the probe command was:

```sh
IMD_PLAYWRIGHT=/tmp/jobzero-revision-tools/node_modules/playwright/index.mjs \
PLAYWRIGHT_BROWSERS_PATH=/tmp/jobzero-revision-browsers \
node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste --offline
```

## Better Interface review and limits

All six pinned domains were reviewed for the changed surface. Accessibility: native action/name, 44px target, keyboard and automated scans checked. Layout: reproduced overlap and rechecked full-precision fees. Writing: reused the existing approval label while retaining costs and the two-step explanation. Typography: full decimal strings wrap without rounding or clipping. Colors: existing tokens retained; the offline probe's measured text contrast passes. UI: existing loading/disabled/confirmation behavior and reduced motion pass the browser suite. No unrelated redesign was made.

No new live-chain reads, real signatures, approvals or funded swaps were performed. All transaction tests are mocked and do not certify deployed execution. Native screen readers, physical devices, browser-native zoom, RTL, OS forced colors and slow-motion animation replay were not tested. IPFS publication and naming remain subsequent control-plane work. Root `DESIGN.md` remains outside the explicit write scope; the existing scoped document `docs/DESIGN.md` was updated.

Machine-readable results: [revision-results.json](evidence/revision-results.json). Screenshots: [before](evidence/revision-before-15-handoffs-390.png), [Chromium after](evidence/revision-chromium-15-handoffs-390.png), [WebKit after](evidence/revision-webkit-15-handoffs-390.png). The response is in repository-root `.imd-responses.json`. Complete for this revision; these are worker-produced checks, not independent certification.
