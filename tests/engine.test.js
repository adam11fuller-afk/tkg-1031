/* ============================================================
   TKG 1031 engine tests — run with:  node tests/engine.test.js
   Verifies the 2026 bracketed tax engine against two hand-checked deals
   and documents how the 1214 Park defaults move vs. the README figures.
   ============================================================ */
const Calc = require('../assets/calc.js');
const { DEFAULTS, compute } = Calc;

let failures = 0;
function approx(name, got, want, tol) {
  tol = tol == null ? 1 : tol;
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${fmt(got)}  want ${fmt(want)} (±${tol})`);
}
function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const r = Math.round(n);
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
function stack(tb) {
  const p0 = tb.ltcg_parts[0] || { amount: 0, tax: 0 };
  const p1 = tb.ltcg_parts[1] || { amount: 0, tax: 0 };
  const p2 = tb.ltcg_parts[2] || { amount: 0, tax: 0 };
  return [
    `    §1250 recapture 25% on ${fmt(tb.gain_recapture_layer)} = ${fmt(tb.tax_recapture)}`,
    `    LTCG 0%  on ${fmt(p0.amount)} = ${fmt(p0.tax)}`,
    `    LTCG 15% on ${fmt(p1.amount)} = ${fmt(p1.tax)}`,
    `    LTCG 20% on ${fmt(p2.amount)} = ${fmt(p2.tax)}`,
    `    NIIT 3.8% = ${fmt(tb.tax_niit)}`,
    `    MA 5.0%  = ${fmt(tb.tax_ma)}`,
    `    MA 4% surtax = ${fmt(tb.tax_surtax)}`,
    tb.tax_1245 ? `    §1245 ordinary = ${fmt(tb.tax_1245)}` : null,
    `    = TOTAL ${fmt(tb.total)}`,
  ].filter(Boolean).join('\n');
}

/* ===========================================================
   TEST (b) — 4 Dean St, Worcester
   price $1.4M; purchased 1985 for $53,000; $0 debt; 20% land;
   fully depreciated ($42,400); 6% broker, $2.28/$500, $5,000 atty, $540 fixed.
   Expected Sell & Pay tax ≈ $357K / $376K / $406K at $100K / $250K / $600K.
   =========================================================== */
console.log('\n=== TEST (b): 4 Dean St, Worcester ===');
const dean = {
  ...DEFAULTS,
  property_address: '4 Dean St, Worcester',
  sale_price: 1400000,
  original_purchase_price: 53000,
  capital_improvements: 0,
  current_mortgage_payoff: 0,
  land_pct: 0.20,
  assessed_land: 0, assessed_building: 0,
  recovery_life: 39,
  year_purchased: 1985, years_held: 41,       // held 41 yrs > 39 → fully depreciated
  improvement_year: 1985, improvement_years_held: 41,
  use_auto_depr: 1,
  broker_pct: 0.06, transfer_rate: 2.28, attorney_costs: 5000, fixed_fees: 540, prepay_penalty: 0,
};
{
  const base = compute(dean);
  console.log(`  transaction_costs ${fmt(base.transaction_costs)}  amount_realized ${fmt(base.amount_realized)}`);
  console.log(`  accumulated_depreciation ${fmt(base.accumulated_depreciation)} (expect $42,400, fully depreciated)`);
  console.log(`  adjusted_basis ${fmt(base.adjusted_basis)}  realized_gain ${fmt(base.realized_gain)}  unrecap_1250 ${fmt(base.unrecap_1250)}`);
  approx('accumulated_depreciation fully depreciated', base.accumulated_depreciation, 42400, 1);
}
const deanExpect = [ [100000, 357000], [250000, 376000], [600000, 406000] ];
for (const [inc, want] of deanExpect) {
  const r = compute({ ...dean, other_taxable_income: inc });
  console.log(`\n  --- other income ${fmt(inc)} ---`);
  console.log(stack(r.A.tax_breakdown));
  approx(`Sell & Pay total tax @ ${fmt(inc)}`, r.A.total_tax, want, 1500); // ≈ to the nearest ~$1k
}

/* ===========================================================
   TEST (a) — 1214 Park defaults vs. the README's verified figures.
   README (old flat engine, other income $0):
     net proceeds  A 996,208 / Full 1,547,421 / Partial 1,319,464 / Levered 1,547,421
     Sell & Pay total tax 551,213
   New engine defaults now carry the Typical $250k income profile.
   =========================================================== */
console.log('\n\n=== TEST (a): 1214 Park defaults vs. README ===');
const README = {
  A_net: 996208, full_net: 1547421, partial_net: 1319464, levered_net: 1547421, A_tax: 551213,
};
// Reproduce the README baseline: the OLD flat engine == the new engine with
// other income $0, a single flat 20% LTCG bracket (collapse 0/15 into 20%),
// AND the NIIT cap disabled (old NIIT was a flat 3.8% on the whole gain, so
// niit_threshold: 0 makes min(gain, gain+other-0) == gain again).
const flatAt0 = compute({
  ...DEFAULTS, other_taxable_income: 0,
  rate_ltcg_0: 0.20, rate_ltcg_15: 0.20, rate_ltcg: 0.20,
  niit_threshold: 0,
});
console.log('\n  [baseline check] new engine, flat 20% LTCG + flat NIIT, other income $0  (should MATCH README):');
approx('A Sell & Pay tax == README 551,213', flatAt0.A.total_tax, README.A_tax, 1);
approx('A net == README 996,208', flatAt0.A.net_position, README.A_net, 1);
approx('Full net == README 1,547,421', flatAt0.B.net_position, README.full_net, 1);
approx('Partial net == README 1,319,464', flatAt0.C.net_position, README.partial_net, 1);
approx('Levered net == README 1,547,421', flatAt0.D.net_position, README.levered_net, 1);

const def = compute(DEFAULTS); // new engine, new defaults (Typical $250k, bracketed)
console.log('\n  [new defaults] bracketed engine, Typical $250k income profile:');
console.log(`  realized_gain ${fmt(def.realized_gain)}  accumulated_depr ${fmt(def.accumulated_depreciation)}`);
console.log('\n  Sell & Pay tax stack now:');
console.log(stack(def.A.tax_breakdown));

function delta(label, now, then) {
  const d = now - then;
  const arrow = Math.abs(d) < 1 ? 'same' : (d > 0 ? '+' + fmt(d) : fmt(d));
  console.log(`  ${label.padEnd(26)} README ${fmt(then).padStart(12)}   now ${fmt(now).padStart(12)}   Δ ${arrow}`);
}
console.log('\n  CHANGES vs README (A/Full≈B,B2/Partial/Levered):');
delta('Sell & Pay total tax', def.A.total_tax, README.A_tax);
delta('Sell & Pay net proceeds', def.A.net_position, README.A_net);
delta('Full (B, DST) net', def.B.net_position, README.full_net);
delta('Full (B2, NNN) net', def.B2.net_position, README.full_net);
delta('Partial net', def.C.net_position, README.partial_net);
delta('Levered net', def.D.net_position, README.levered_net);
delta('Partial total tax', def.C.total_tax, 227957);

console.log('\n  Levered depreciation (fully-depreciated-safe):');
console.log(`    remaining_recovery ${def.D.remaining_recovery} yrs  carryover/yr ${fmt(def.D.carryover_annual)}  excess/yr ${fmt(def.D.excess_annual)}  total/yr ${fmt(def.D.annual_depreciation)}`);

/* ===========================================================
   Levered depreciation: regression for the floored-1 bug.
   A building held PAST its recovery life must yield 0 carryover depreciation,
   not basis ÷ 1.
   =========================================================== */
console.log('\n=== TEST (c): levered depreciation past recovery life ===');
{
  const past = compute({ ...dean, levered_pct: 1.25 }); // 4 Dean held 41 yrs > 39
  console.log(`  remaining_recovery ${past.D.remaining_recovery}  carryover_annual ${fmt(past.D.carryover_annual)} (must be $0)`);
  approx('carryover_annual is 0 when fully depreciated', past.D.carryover_annual, 0, 0.01);
  const ok = Number.isFinite(past.D.annual_depreciation) && past.D.annual_depreciation >= 0;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  annual_depreciation finite & ≥ 0: ${fmt(past.D.annual_depreciation)}`);
}

/* ===========================================================
   NIIT cap + MA surtax increment sanity (other income $0).
   =========================================================== */
console.log('\n=== TEST (d): NIIT cap & surtax increment ===');
{
  const r0 = compute({ ...DEFAULTS, other_taxable_income: 0 });
  const tb = r0.A.tax_breakdown;
  // NIIT base = min(gain, gain + 0 - 250000) = gain - 250000
  approx('NIIT at $0 other income caps at (gain-threshold)*3.8%',
    tb.tax_niit, (r0.realized_gain - DEFAULTS.niit_threshold) * 0.038, 1);
  // surtax increment at $0 other income = (gain - 1,107,750)*4%
  approx('MA surtax increment at $0 other income',
    tb.tax_surtax, Math.max(0, r0.realized_gain - DEFAULTS.ma_surtax_threshold) * 0.04, 1);
}

console.log('\n============================================');
console.log(failures === 0 ? 'ALL ASSERTIONS PASSED' : `${failures} ASSERTION(S) FAILED`);
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
