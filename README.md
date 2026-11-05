# TKG 1031 Exchange & Financing Calculator

A client-side web calculator that compares a Massachusetts CRE sale against §1031 exchange
strategies, and prints a branded, Excel-style client report. **No backend** — all math runs in
the browser; inputs save only to the visitor's own `localStorage`.

Live: https://tkg-1031.pages.dev · Repo: `adam11fuller-afk/tkg-1031` (this `dist/` folder is the
deployed copy; Cloudflare Pages auto-deploys on push to `main`).

Scenarios: **A — Sell & Pay**, **B / B2 — two full §1031 exchanges** (defaults: *1031 into DST* at
4.75% and *1031 into Absolute NNN* at 6.25%, so you can compare product types), **C — Partial**,
**D — Leveraged**. Every scenario has an editable label, a show/hide toggle, and its own cap rate
and financing.

---

## Tabs
- **Assumptions & Inputs** — guided form: property, improvements, depreciation, **client income
  profile**, selling costs, exchange sizing & scenarios, tax rates & thresholds, cost-seg.
- **Client Summary** — on-screen comparison + an "at a glance" chart. The on-screen look is
  unchanged; the **Print Report** button produces the Excel-style report below.
- **Scenario Detail** — per-scenario full tax stack (recapture → LTCG 0/15/20 → NIIT → MA → surtax
  → §1245) and economics.
- **Financing Tool** — standalone conventional vs. interest-only debt sizing.
- **Saved Deals** — save/compare deals locally.

## Run locally
Double-click `index.html`, or serve the folder (`python3 -m http.server 4031`). Scripts are plain
(non-module) so `file://` works offline.

## Tests
```bash
node tests/engine.test.js
```
Verifies the tax engine against two hand-checked deals and reproduces the historical README figures.

---

## The tax engine (`assets/calc.js`, 2026, MFJ defaults)

Everything is a pure function; every rate and threshold is an editable input.

**Shared blocks**
```
transaction_costs = sale_price*broker_pct + sale_price/500*transfer_rate + attorney + fixed + prepay
amount_realized   = sale_price − transaction_costs
adjusted_basis    = original_purchase_price + capital_improvements − accumulated_depreciation
realized_gain     = amount_realized − adjusted_basis
unrecap_1250      = min(accumulated_depreciation, max(0, realized_gain))
```

**Depreciation (straight-line)**
- Building: `original_purchase_price × (1 − land%)` over `recovery_life`, from acquisition.
- Improvements: entered as a **lump sum + year placed in service**; 100% depreciable (no land), on
  their own clock from that year.
- **Fully depreciated** once years-held ≥ recovery life (no partial-year past the life).
- A **manual accumulated-depreciation override wins** when entered (typing it turns auto off).

**Land %** — enter the assessor's **land** and **building** values and land% =
`land / (land + building)` ("per assessor"); otherwise the 20% default. Assessed *building* value is
never treated as capital improvements.

**`tax(recognized_gain)` — the stack**
1. **§1250 recapture** — `min(gain, unrecap_1250) × 25%`.
2. **Federal LTCG** — the remaining layer runs through the **0% / 15% / 20%** brackets, stacked on
   top of `other_income + the §1250 layer`. 2026 MFJ breakpoints **$98,900** and **$613,700**.
3. **NIIT** — `3.8% × min(recognized_gain, max(0, other_income + gain − $250,000))` (the MAGI cap).
4. **MA income** — `5% × recognized_gain`.
5. **MA 4% surtax** — on the **gain increment above the threshold only**:
   `[max(0, other + gain − $1,107,750) − max(0, other − $1,107,750)] × 4%`.
   Pre-existing other income already over the line is *not* re-counted.
6. **§1245** — `sec1245_depreciation × ordinary_rate` when the cost-seg flag is on.

Deferred exchanges recognize `$0`, so their whole stack is `$0`.

**Client income profile** — instead of asking the client's income, pick **Moderate $100K /
Typical $250K (default) / High $600K**, or type a custom override. This sets the `other_income`
that stacks beneath the gain and drives the brackets, NIIT cap, and surtax base.

**Exchange sizing** — full deferral replaces value, equity **and** debt. Recognized boot =
`cash not reinvested + old debt not replaced by new debt`.
- Full (B, B2): replace the full net value; new loan = old debt. Recognized = 0.
- Partial (C): reinvest `partial_pct` of equity; optionally replace the debt; the rest is cash boot.
- Levered (D): buy up to `levered_pct × net sale price`; the gap is financed.

**Levered depreciation (§1.168(i)-6, fully-depreciated-safe)**
```
remaining_recovery        = max(0, recovery_life − years_held)
remaining_carryover_basis = max(0, depreciable_cost − accumulated_depreciation)
carryover_annual          = remaining_recovery > 0 ? remaining_carryover_basis / remaining_recovery : 0
excess_annual             = max(0, replacement_depreciable_basis − remaining_carryover_basis) / recovery_life
annual_depreciation       = carryover_annual + excess_annual
```
Past the recovery life the carryover tier is **0** — it never divides by a floored 1.

---

## What changed this round (vs. the prior flat engine)

1. **Bracketed federal LTCG** — was a flat 20%; now 0/15/20 stacked on other income + §1250.
2. **Capped NIIT** — was 3.8% of the whole gain; now `3.8% × min(gain, MAGI over $250K)`.
3. **Surtax on the increment only** — the 4% surtax no longer re-counts pre-existing other income.
4. **Levered depreciation fix** — buildings held past their recovery life no longer produce a bogus
   carryover deduction (the old `÷ max(1, life − held)` floored to 1).
5. **Improvements on their own clock** — lump sum + year-in-service, depreciated from that year.
6. **Assessor land split** — optional land/building inputs drive a precise, labeled land %.
7. **Income profile** — Moderate/Typical/High + override, never framed as asking the client.
8. **Second full exchange (B2)** + editable labels and show/hide on every scenario (DST vs. NNN).
9. **Prepared-for / property-address** inputs that print on the report.
10. **New print report** — a branded, Excel-style, 2-page US-Letter-landscape client report
    (`@media print`), separate from the unchanged on-screen app.

### Verified figures

**1214 Park defaults** (now carry the Typical **$250K** profile; vs. the old README figures, which
were the flat engine at **$0** other income):

| Figure | Old README | Now | Why |
|---|--:|--:|---|
| Sell & Pay total tax | $551,213 | **$548,157** | LTCG bracketing −$13,057 (part of the gain taxes at 15%); +$10,000 surtax (the $250K profile pushes more gain over $1,107,750). NIIT/MA/recapture unchanged at this income. |
| Sell & Pay net proceeds | $996,208 | **$999,265** | Mirror of the lower tax. |
| Full (B DST / B2 NNN) net | $1,547,421 | **$1,547,421** | Unchanged (deferred; $0 tax). |
| Partial net | $1,319,464 | **$1,332,521** | Partial tax falls to $214,900 (LTCG bracketing); boot's $773,711 alone stays under the surtax line at $250K. |
| Levered net | $1,547,421 | **$1,547,421** | Unchanged (deferred). |

The old figures still reproduce exactly from the new engine with a flat 20% LTCG, a flat NIIT
(`niit_threshold = 0`), and `$0` other income — see `tests/engine.test.js`.

**4 Dean St, Worcester** — $1.4M sale; $53,000 bought 1985; $0 debt; 20% land; fully depreciated
($42,400); 6% broker, $2.28/$500, $5,000 attorney, $540 fixed. Sell & Pay tax by income:

| Other income | $100K | $250K | $600K |
|---|--:|--:|--:|
| Sell & Pay tax | **$356,805** | **$376,005** | **$406,070** |

(Spec targets ≈ $357K / $376K / $406K.) Full stack per profile prints on the test output and the
report's "Estimated tax by other income" table.

---

## File map
| File | Purpose |
|---|---|
| `index.html` | Shell: masthead, tabs, view mounts, `#print-report` container |
| `assets/calc.js` | **Calculation engine** — pure functions; `window.Calc` + `module.exports` (for tests) |
| `assets/app.js` | UI: inputs, income profile, scenarios, charts, scenario detail, **print report** |
| `assets/styles.css` | On-screen branding + the `@media print` Excel-style report |
| `tests/engine.test.js` | Node test suite (4 Dean, 1214 deltas, levered-depr, NIIT/surtax) |

> Estimates only — not tax or legal advice. §1031 deferral requires replacing value, equity, AND
> debt, plus the 45-day identification / 180-day closing deadlines. Confirm with your CPA and attorney.
