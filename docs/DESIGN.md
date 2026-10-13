# JOB #0 design system

## Overview

JOB #0 is an Ethereum contract explorer and gameplay interface for Teyo holders. Its visual language follows the brief: a corrupted IMD record, black surfaces, white monospace text, thin square borders and red verification failures. The job record comes before explanation, with wallet access in the header and the applicable contract action inside the record. Queue, attempts, bounties and failed workers are structured as explorer lists; the story and four-step guide follow the working interface.

This document describes the final implementation in `web/src/`, not a proposed redesign. It lives under `docs/` because the assignment's explicit write budget protects repository-root files. No root `DESIGN.md` was created.

## Colors

Canonical tokens are in `web/src/styles.css:1`. The app deliberately provides one dark appearance, with `color-scheme: dark` and no theme toggle.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#080808` | Page, fields, fixed status bar |
| `--surface` | `#101010` | Job record, secondary controls, wallet disclosure |
| `--surface-hover` | `#1c1c1c` | Hovered and disabled primary controls |
| `--text` | `#f4f4f0` | Main text, heading and default status dot |
| `--muted` | `#a3a3a0` | Supporting copy, labels, units |
| `--border` | `#363636` | Structural section/list separators |
| `--control-border` | `#777773` | Controls, job record, wallet disclosure |
| `--danger` | `#ff7474` | Failure stamp, errors, worker alert, expired deadline |
| `--danger-surface` | `#200d0d` | Error notice background |
| `--accent` | `#f4f4f0` | Primary action background |
| `--accent-text` | `#080808` | Primary action text |
| `--focus` | `#ffffff` | Keyboard focus indicator |

Primary-action hover uses `#d4d4ce`. Status always includes words as well as color. The probe measured 18.16:1 for primary text and primary-button text, 7.92:1 for muted hero text on the page, and 7.63:1 for the failure stamp on the page. These are measured solid-background pairs, not a claim about every possible browser/system color combination. The source also preserves a forced-colors `Highlight` outline.

## Typography

The system stack is `"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`; no font download or webfont asset is required. Actual font selection depends on the visitor's installed fonts. Chromium and WebKit were checked on this Linux worker; no claim is made about a particular font file being loaded.

There are six size tokens: `--text-xs` 12px, `--text-sm` 14px, `--text-base` 16px, `--text-lg` 20px, `--text-xl` 32px and `--text-display` 56px at the default 16px root. Only 400 and 700 weights are authored. H1 is 56px/700 with line-height 1 and -0.05em tracking. H2 is 20px/700 at 1.3; H3 is 16px/700 at 1.4. Body line-height is 1.5, and longer help copy uses 1.6. Supporting UI copy is usually 12px or 14px; inputs remain 16px on phones.

Numeric data uses `font-variant-numeric: tabular-nums`. The countdown is 56px on wide screens and 32px below 860px. The smallest-phone headline is 32px below 360px. Uppercase is limited to explorer labels, status tags and the deliberately authored assignment alert. Headings balance their wrapping; paragraphs use pretty wrapping. Addresses and token amounts wrap rather than being clipped. `TokenAmount` keeps exact decimal precision for values a visitor may act on; the compact burned counter rounds for display.

## Layout

The main container is at most 1184px wide. Desktop sections share that alignment edge, with 40px gaps between paired explorer columns. Spacing uses a small recurring set: 4, 8, 12, 16, 20, 24, 28, 32, 40 and 56px. Groups use larger separation than labels and values within a group.

The working breakpoints are 1240px, 860px, 660px and 359px. Below 1240px the container has 28px side margins. Below 860px the countdown steps down and the documentation grid becomes two columns. Below 660px the page uses 16px margins, paired panels stack, forms use one column and main actions stretch to available width. Within the mobile job record, deadline and current worker share two columns so the worker's handoff stays on the first screen at 390px. Below 360px that group stacks and the header hides only its duplicate help link; the documentation remains reachable through its page section.

The fixed live bar has bottom safe-area padding and a reserved 100–112px page-bottom space. At mobile widths it displays online workers, attempts and burned TEYO in a wrapping row. Wallet disclosure width is capped at the viewport minus 32px; full addresses break across lines. Fields use `min-width: 0`; metric/grid columns use `minmax(0, 1fr)`.

Below 660px, the assignment uses a 6px internal gap. Paid actions use the concise “Approve TEYO” label while their adjacent explanation and metrics retain the exact fee. With seven- and fifteen-handoff fee growth, the 44px approval button stays above the live bar on the first 390×844 screen in both tested engines; see `docs/frontend-revision.md`.

Production exports were checked at 320, 390, 768 and 1440 CSS pixels in Chromium and WebKit, including an open wallet disclosure at 320px and large token balances. Results and explicit limitations are in `docs/frontend-validation.md`.

## Elevation & Depth

This is a flat interface. Thin borders describe records, controls and list divisions; there are no drop shadows or gradient text. `#trade` is a single bordered panel. The wallet disclosure uses a solid surface at z-index 30, the fixed status bar z-index 20 and the skip link z-index 100. Main content remains in document flow.

## Shapes

Controls are square, with a 1px border and zero radius. The failure stamp is a rectangular red outline rotated -5 degrees, with a small broken-corner × artifact. Icons use inline SVG or simple glyphs rather than an external icon font. The brand mark is decorative SVG within a named home link. The status dot is a 6px square with an accompanying text label.

## Components

| Pattern | Source | Behavior and reuse |
| --- | --- | --- |
| `Section` | `web/src/App.tsx` | Named `<section>` with heading and optional trailing metadata; use for explorer sections rather than nested card boxes. |
| `AddressView` | `web/src/App.tsx` | Checksummed explorer link, optional full address and explicit copy button. Full value remains available through title, accessible name and explorer; copy failure is shown inline. |
| `TokenAmount` | `web/src/App.tsx` | TEYO value and muted unit; exact values are selectable and wrap. Unknown reads show a dash rather than invented zero balances. |
| `.button` / `.button-primary` | `web/src/styles.css` | 44px minimum action height; filled white for the main next step, dark outlined for secondary actions. Native disabled state, visible keyboard focus, restrained 120ms color/background/border transitions. |
| `.field-action`, `.form-grid` | `web/src/styles.css` | Native labels and inputs, bound inline validation, wrapping adjacent controls; mobile inputs remain 16px. |
| Job record and assignment | `web/src/App.tsx` | Status, countdown, worker and metrics precede the applicable connect/switch/approve/action control. Unsupported prerequisites explain the disabled state. |
| `useTransactions` status | `web/src/useGame.ts` and `web/src/App.tsx` | Simulation, wallet confirmation, submitted, success, revert and unknown-confirmation states. A submitted action remains locked until confirmation is resolved; explorer links preserve access to its hash. |
| `SwapPanel` | `web/src/SwapPanel.tsx` | Buy/sell selection, exact input, slippage, quote/minimum/rate, separate ERC20 and Permit2 approval stages, simulation and execution. Quote/funds errors stay by these controls. |
| Explorer lists | `web/src/App.tsx` | Queue/attempt rows, newest-first ordering, pagination and empty/error states. Expanded lists identify their block snapshot and offer explicit refresh. History is shared by claims and failed-worker records. |
| Wallet disclosure | `web/src/App.tsx` | Native `<details>` with account, full address, network, balance and Disconnect. Hidden content is reachable through the visible summary. |
| `.notice`, `.error` | `web/src/styles.css` | Plain recovery messages with text and color; status/alert roles match urgency. |
| Failure effects | `web/src/styles.css` | 12s stamp-flicker and 2s cursor animation only under `prefers-reduced-motion: no-preference`. A visible Pause glitch effects control stops both. |

Metadata is authored in `web/index.html`. `web/public/favicon.svg` is local. The local 1200×630 share graphic is `web/public/share.png`; its typography/layout source is `web/assets/share.html`. The preview image uses relative URLs because the host is assigned after delivery.

## Do's and Don'ts

- Start another explorer surface with `Section`, the existing container/grid and size/color tokens. Keep the product and its current action above explanatory material.
- Reuse native buttons, labelled fields and document headings. Keep exact addresses and amounts reachable and selectable.
- Preserve the connect → switch → approval → action sequence. Show eligibility, quote limits and irreversible effects before signing; unknown or stale reads cannot authorize a transaction.
- Keep one prominent next transaction step per flow. Use text to explain red status rather than relying on red alone.
- Retain flat square surfaces and thin separators. Do not introduce rounded marketing cards, shadow stacks, new fonts or tracked kicker labels above sections.
- Keep runtime deployment data in the exported manifest and its referenced ABIs. A future page imports the existing runtime configuration instead of adding another address or RPC table.
- Use the existing reduced-motion and pause behavior for any new decorative effect. Do not animate transaction affordances continuously.
