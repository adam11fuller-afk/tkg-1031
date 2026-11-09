# TKG 1031 Exchange & Financing Calculator

A client-side web calculator that compares a Massachusetts CRE sale against §1031 exchange
strategies, and prints a branded, Excel-style client report. **No backend** — all math runs in
the browser; inputs save only to the visitor's own `localStorage`.

> **This file is how the CODE works** — formulas, the report's mechanics, verified figures.
> How the **project** works lives one level up, outside this repo:
> `../START HERE.md`, `../docs/ARCHITECTURE.md`, `../docs/WORKFLOW.md`,
> `../docs/DECISIONS.md` (read before changing the report), `../docs/OPEN-ITEMS.md`.

Live: https://tkg-1031.pages.dev · Repo: `adam11fuller-afk/tkg-1031` (this `dist/` folder is the
deployed copy; Cloudflare Pages auto-deploys on push to `main`).

Scenarios: **A — Sell & Pay**, **B / B2 — two full §1031 exchanges**, **C — Partial**,
**D — Leveraged** (1.25× buy-up at a 7.25% cap). Every scenario has an editable label, an editable
sub-label that prints under the column head, a show/hide toggle, and its own cap rate and financing.

> **B and B2 are the same exchange into different replacements.** A full exchange defers the whole
> gain whatever you buy; only the return changes. The shipped defaults are *1031 into DST* at 4.75%
> and *1031 into NNN* at 6.25%, but they are just defaults: set either to an absolute NNN, a plain
> NNN, multifamily, a development, anything that qualifies, and move the cap rate to match. Nothing
> in the report hardcodes a product type.

> On the levered column: the loan constant at 6.4% over a 30-year amortization is **7.51%**, so at a
> 7.25% cap the extra debt is roughly break-even. The higher cash flow comes from buying a
> higher-yielding asset, not from the leverage. Raise the cap above 7.51% for genuinely positive leverage.

---

## Tabs
- **Assumptions & Inputs** — guided form: property, improvements, depreciation, **client income
  profile**, selling costs, exchange sizing & scenarios, tax rates & thresholds, cost-seg.
- **Client Summary** — on-screen comparison + an "at a glance" chart. The **Print Report** button
  produces the Excel-style report below. The full tax stack now lives on sheet 2 of that report, so
  the old read-only *Scenario Detail* tab was removed rather than kept as a second copy of it.
- **Financing Tool** — a standalone scratchpad for sizing a loan side by side, conventional vs.
  interest-only: LTV, equity required, annual debt service, DSCR, net cash flow, cash-on-cash. It is
  **not wired to the scenarios or the report** — every exchange column carries its own cap rate,
  loan rate, term and amortization on the Assumptions tab, including the levered one. Use it to
  sanity-check a lender quote before typing that rate into a scenario.
- **Saved Deals** — save/compare deals locally.

## Run locally
Double-click `index.html`, or serve the folder (`python3 -m http.server 4031`). Scripts are plain
(non-module) so `file://` works offline.

## Tests
```bash
node tests/engine.test.js       # two hand-verified deals + the filing-status switch
node tests/invariants.test.js   # 4,000 generated deals: every field finite, identities hold
```
Verifies the tax engine against two hand-checked deals, reproduces the historical README figures,
and checks that the filing-status switch moves all three thresholds into the engine (not just the
labels) and that the resulting tax ranks joint ≤ head of household ≤ single ≤ married-filing-separately.

---

## The tax engine (`assets/calc.js`, 2026, joint-return defaults)

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
   top of `other_income + the §1250 layer`. Breakpoints come from the filing status (below).
3. **NIIT** — `3.8% × min(recognized_gain, max(0, other_income + gain − niit_threshold))` (the MAGI
   cap). The threshold comes from the filing status.
4. **MA income** — `5% × recognized_gain`.
5. **MA 4% surtax** — on the **gain increment above the threshold only**:
   `[max(0, other + gain − $1,107,750) − max(0, other − $1,107,750)] × 4%`.
   Pre-existing other income already over the line is *not* re-counted.
6. **§1245** — `sec1245_depreciation × ordinary_rate` when the cost-seg flag is on.

Deferred exchanges recognize `$0`, so their whole stack is `$0`.

**Client income profile** — instead of asking the client's income, pick **Moderate $100K /
Typical $250K (default) / High $600K**, or type a custom override. This sets the `other_income`
that stacks beneath the gain and drives the brackets, NIIT cap, and surtax base.

### Filing status

The switch in section 4 is **not a label** — it rewrites three real thresholds in section 7 and
changes the tax. `FILING_STATUS` in `calc.js` is the single source of truth; `DEFAULTS` reads its
joint-return row, the dropdown is generated from its keys, and `applyFilingStatus(inputs, status)`
writes the figures in.

| | LTCG 0%→15% | LTCG 15%→20% | NIIT MAGI |
|---|--:|--:|--:|
| Married filing jointly | $98,900 | $613,700 | $250,000 |
| Qualifying surviving spouse | $98,900 | $613,700 | $250,000 |
| Single | $49,450 | $545,500 | $200,000 |
| Head of household | $66,200 | $579,600 | $200,000 |
| Married filing separately | $49,450 | $306,850 | $125,000 |

LTCG breakpoints are **Rev. Proc. 2025-32 §4.03** as published in **IRB 2025-45**. Two quirks of
that table: it has no *single* row (single filers are "All Other Individuals") and no separate
*qualifying surviving spouse* row (QSS rides "Married Individuals Filing Joint Returns and
Surviving Spouses"), which is why QSS carries the joint figures. NIIT thresholds are statutory —
**IRC §1411(b)** — and have never been indexed, so a 2025-dated source is not stale for them;
OBBBA did not amend §1411.

**The MA surtax threshold deliberately does NOT move with filing status.** It is one per-return
figure ($1,107,750 for 2026) and is **not doubled** on a joint return. Since TY2024 a couple filing
a joint federal return must also file jointly in Massachusetts (M.G.L. c.62C §6(a)(2), added by
St. 2023 c.50 §46), so they cannot file separately in MA to claim two thresholds. That is why it
sits outside `FILING_STATUS`.

`reconcileFilingStatus()` runs on every path that hydrates saved inputs, because the dropdown used
to be an inert label: anything saved then can hold `filing_status: 'single'` over the joint-return
figures and would otherwise compute joint tax under a "Single" label. The rule is narrow — if the
stored thresholds are exactly some *other* status's standard set they are stale and get re-applied;
if they match no status at all someone typed them, and the override is kept. There are four such
paths, not one: `loadState()` for the live inputs, and `dealInputs()` for the saved-deals list, the
compare table and loading a deal. Every saved deal goes through `dealInputs()` — add a fifth caller
and it must too, or that view will quietly disagree with the others.

Changing the switch overwrites any manual override of those three figures, so set the status first
and let a CPA tune afterwards. Sell & Pay tax on 4 Dean at $250K other income, by status:
**$376,005** joint and QSS, **$377,710** head of household, **$379,415** single, **$391,348**
married filing separately.

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
7. **Income profile** — Moderate/Typical/High + override, never framed as asking the client. A
   working **filing-status switch** (joint / QSS / single / HOH / MFS) drives both LTCG breakpoints
   and the NIIT threshold; it used to be an inert label over hard-coded joint-return figures.
8. **Second full exchange (B2)** + editable labels and show/hide on every scenario (DST vs. NNN).
9. **Prepared-for / property-address** inputs that print on the report.
10. **New client report** — a branded, two-sheet, US-Letter-landscape report (`@media print`),
    separate from the unchanged on-screen app. See below.

## The client report (`@media print`)

Two sheets, US Letter landscape, 0.4in margins, built as an Excel template: Arial, a gridline on
every cell, navy `#002855` section bands, blue figures for inputs, `$#,##0` with parentheses for
negatives and an en-dash for zero.

- **Sheet 1, the comparison.** Letterhead, a property/prepared-for/date strip, then one grid:
  Sell & Pay, Partial, the two full exchanges under a spanning **FULL EXCHANGE** band, and Levered.
  Sections are THE SALE, THE GAIN AND THE TAX, THE REPLACEMENT PROPERTY, ANNUAL CASH FLOW and
  WHERE YOU LAND (total tax paid, then what you keep or reinvest). Numbered footnotes below.
- **Sheet 2, how it works.** The 45/180 timeline including the three-property identification rule,
  plain-English explainers for how a 1031 works and how to choose the replacement property (which
  covers the whole spectrum, a DST through to a development, rather than naming one product), the
  tax calculation per taxed scenario, and every assumption.

**It generates from the inputs.** The prose is fixed boilerplate that never changes between deals,
and every variable sits in its own cell, so no copy is rewritten per deal. Hiding a scenario drops
its column and the FULL EXCHANGE band collapses on its own.

**Two sheets, always — fit to page.** A long address, a long client name, long scenario labels, an
extra footnote or the cost-seg row can all push a sheet past one page, and tuned padding only holds
for the deal it was tuned on. So `fitPrintPages()` measures what each sheet actually needs and sets
`zoom` to shrink it onto one page, exactly as Excel's *Fit to one page* does (floor 0.78; it runs on
every render, on the Print Report button, and on the browser's own `beforeprint`, so ⌘P is covered
too). This is why the report's CSS lives **outside** `@media print` and `#print-report` is parked
off-screen rather than `display: none` — it needs a real layout box at the true printable width
(10.2in) for those measurements to be the print measurements. `zoom`, not `transform`: a transform
only repaints smaller, leaving the original box to break across pages.

The Playwright render harness is not committed (it needs chromium), but it renders four deals —
1214 Park, 4 Dean, a toggled-column case, and a deliberate worst case (long wrapping names, five
columns, cost seg on, a partial that neither replaces the debt nor covers its own tax) — and
asserts 2 PDF pages with no overflow in **either** dimension. Checking height alone is not enough:
a width bug once clipped the last column out of the PDF while every height check read clean. The
worst case fits at 0.954.

The assumptions block has the same fragility and needed a different fix. Its two columns are narrow,
so one long value — "Married filing separately" — widened the value column under auto table layout,
squeezed the labels and wrapped five unrelated rows, costing 56px. Pinning the split with
`table-layout: fixed` stopped the cascade but made it worse to read: the narrower value column then
split **"$100,000 to $600,000"** across two lines, and a dollar range broken mid-value is not
something to print for an owner. The fix is structural — the two assumptions *about the client*
(income band, filing status) are the long ones, so they sit in a full-width strip beneath the two
property columns, which went back to auto layout. Sheet 2 measures a flat 733px for every filing
status and both values stay on one line, "Qualifying surviving spouse" included.

The lesson for the harness: it asserts page geometry, and page geometry was *fine* through all of
this — a value wrapping mid-range changes nothing about the height. Check the rendered text, not
just the box.

**The identification strip shares the grid's columns.** It used to be auto-layout with 12% labels,
so its cell widths came from their contents: its divisions fell at 12/28/40/62/74% while the grid's
columns are at 25/40/55/70/85%, and almost nothing lined up. Worse, a longer client name moved every
division, so the strip was ragged in a different place on each deal.

The first fix pinned it to `table-layout: fixed` at 25/15/15/15/15/15 — **which was right only for
the default deal.** The grid is one 25% row-label column plus *one column per visible scenario*, so
hiding a scenario re-divides it: four scenarios split at 25/43.75/62.5/81.25, three at 25/50/75.
Toggling a column off is routine, so the strip went ragged again for most real deals and the harness
could not see it, because hiding a column changes nothing about page height or width.

`prIdStrip()` now emits a `<colgroup>` mirroring the grid's own columns and distributes the three
label/value pairs across them, giving extra columns to the leftmost pair (addresses are the long
value) and collapsing a pair into a single inline cell where it can only have one column. Verified
aligned at 5, 4, 3, 2 and 1 visible scenarios. A one-scenario report has nothing to align to, so the
strip runs inline in a single cell with no internal divisions at all.

The address column is one grid column wide, so a very long address wraps and pushes sheet 1 to a
0.914 fit. Real addresses are short, and wrapping beats silently truncating a client's address.

For the same reason the sheet-2 cap-rate rows lost their `Cap rate, ` prefix and sit under a group
heading instead. `Cap rate, 1031 into Absolute NNN` could not fit that column and wrapped every one
of those rows to two lines, along with `varies by scenario` next to it.

**The income assumption is never stated.** Rather than claim to know the client's income, sheet 1
footnotes a band (`report_income_lo` to `report_income_hi`, shipped at **$100,000 to $600,000**,
where most owners fall) and the tax range across it, noting there is some variation. Sheet 2 carries
the band as an input cell and repeats the range under the tax total. At the 1214 Park defaults that
range is **$528,957 to $575,213**. Both ends are editable inputs.

Filing status never appears on sheet 1. It is listed once on sheet 2, in the ASSUMPTIONS AND INPUTS
block, as an input the client can correct — the same block that already carries the income band and
says "tell us if any are wrong." The tax range in the footnote follows the selected status too, so a
single-filer deal no longer prints joint-return numbers with nothing to say so.

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

## Guards against a wrong number reaching a client

**Nothing can print as ($∞).** `PMT` returns 0 rather than ±Infinity when the period count is
not positive, and `sanitize()` clamps `recovery_life` and every scenario's term and amortisation to
a minimum of 1 year before `compute()` runs. These are divisors: a 0 there is a typo, not a
judgement call. `compute()` returns both `inputs` (sanitized, what the engine used and what the
report shows) and `raw_inputs` (exactly as typed), and the UI compares them so it can say a value
was clamped — checking the sanitized copy would always look clean, which is the bug the first
version of this had.

**Data-hygiene checks** (`buildDataChecks`) are separate from the economic warnings and never print.
They catch input mistakes that would otherwise reach a CPA looking deliberate: no prepared-for name,
no address, a $0 original purchase price, a future purchase year, cost-seg on with a $0 §1245
figure, improvements dated before the purchase, a clamped input, a deal that is actually a loss, and
above all **a manual accumulated-depreciation figure**, which states both the typed figure and what
auto would have given. Print asks for confirmation once when any are outstanding.

**New deal vs Reset.** State is one flat object that persists, so starting a new owner by overwriting
the sale fields used to carry the previous building's depreciation with it — and because typing a
manual figure also switches auto off permanently, it kept applying. On one real pair of deals that
overstated the tax by **$160,272** with nothing on the report to show it. `New deal` clears
`DEAL_FIELDS` (the property, the client, basis, improvements, assessed values, manual depreciation,
cost seg) and keeps the standing assumptions (selling-cost rates, cap rates, loan terms, filing
status, income band). `Reset` still restores the 1214 Park sample in full.

## File map
| File | Purpose |
|---|---|
| `index.html` | Shell: masthead, tabs, view mounts, `#print-report` container |
| `assets/calc.js` | **Calculation engine** — pure functions; `window.Calc` + `module.exports` (for tests) |
| `assets/app.js` | UI: inputs, income profile, scenarios, charts, scenario detail, **print report** |
| `assets/styles.css` | On-screen branding + the `@media print` Excel-style report |
| `tests/engine.test.js` | Node suite: 4 Dean, 1214 deltas, levered-depr, NIIT/surtax, filing status |
| `tests/invariants.test.js` | Fuzz/invariant suite: 4,000 generated deals, every field finite |

> Estimates only — not tax or legal advice. §1031 deferral requires replacing value, equity, AND
> debt, plus the 45-day identification / 180-day closing deadlines. Confirm with your CPA and attorney.
