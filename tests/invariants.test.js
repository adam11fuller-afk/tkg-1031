/* ============================================================
   TKG 1031 — invariant / fuzz suite.  node tests/invariants.test.js

   engine.test.js checks two hand-verified deals. It cannot see the class of
   bug where an ORDINARY MIS-KEY produces a number that is not a number: typing
   0 into the Amort column used to send the payment calc a zero period count,
   and "Cash flow to you, each year" printed ($∞) on the client report.

   So this suite asks a different question: across a wide spread of hostile but
   typeable inputs, is every number the report can show a real number, and do
   the structural identities hold for every deal?
   ============================================================ */
const { DEFAULTS, compute, FILING_STATUS, applyFilingStatus } = require('../assets/calc.js');

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };

/* Deterministic pseudo-random so a failure is reproducible from the seed. */
let seed = 20261109;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];

const POOL = {
  sale_price:               [0, 1, 250000, 1400000, 2355000, 50000000],
  original_purchase_price:  [0, 1, 53000, 500000, 9000000],
  current_mortgage_payoff:  [0, 650000, 3900000, 99000000],
  capital_improvements:     [0, 640000],
  land_pct:                 [0, 0.2, 1],
  recovery_life:            [0, 1, 27.5, 39],
  year_purchased:           [1960, 1985, 2016, 2026, 2030],
  partial_pct:              [0, 0.5, 1],
  levered_pct:              [0, 1, 1.25, 4],
  other_taxable_income:     [0, 250000, 5000000],
  b_yield:                  [0, 0.0475, 0.25],
  d_yield:                  [0, 0.0725, 0.25],
  b_rate:                   [0, 0.064, 0.25],
  d_rate:                   [0, 0.064, 0.25],
  b_amort:                  [0, 1, 30],
  d_amort:                  [0, 1, 30],
  b_term:                   [0, 15],
  d_term:                   [0, 15],
  use_auto_depr:            [0, 1],
  manual_depreciation:      [0, 423900, 99000000],
  cost_seg_flag:            [0, 1],
  sec1245_depreciation:     [0, 285000],
  partial_replace_debt:     [0, 1],
};

/* The ONE legitimately infinite value: the top capital-gains band has no
   ceiling by definition. It is a bracket boundary, never a printed figure. */
const ALLOWED_INFINITE = /(^|\.)ltcg_brackets\[\d+\]\.upto$/;

/* Walk the whole result tree — the report reads from all of it. */
function nonFinite(o, path, out) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'number') {
      if (!Number.isFinite(v) && !ALLOWED_INFINITE.test(path + k)) out.push(path + k + '=' + v);
    }
    else if (Array.isArray(v)) v.forEach((e, n) => {
      if (e && typeof e === 'object') nonFinite(e, `${path}${k}[${n}].`, out);
      else if (typeof e === 'number' && !Number.isFinite(e)) out.push(`${path}${k}[${n}]=${e}`);
    });
    else if (v && typeof v === 'object') nonFinite(v, path + k + '.', out);
  }
  return out;
}

const N = 4000;
console.log(`\n=== INVARIANTS: ${N} generated deals ===`);
let worstBad = null;
for (let n = 0; n < N; n++) {
  const inp = { ...DEFAULTS };
  for (const k of Object.keys(POOL)) inp[k] = pick(POOL[k]);
  inp.years_held = Math.max(0, 2026 - inp.year_purchased);
  const status = pick(Object.keys(FILING_STATUS));
  const r = compute(applyFilingStatus(inp, status));

  const bad = nonFinite(r, '', []);
  if (bad.length && !worstBad) { worstBad = { inp, status, bad }; }
  if (bad.length) { fail(`non-finite: ${bad.slice(0, 4).join(', ')}`); break; }

  for (const key of ['A', 'B', 'B2', 'C', 'D']) {
    const s = r[key];
    if (!s) continue;
    // A sale below basis is a real loss, so recognized_gain may go negative —
    // but only when the deal itself is a loss, never on a profitable sale.
    if (s.recognized_gain < -0.01 && r.realized_gain > 0) { fail(`${key}: negative recognized_gain ${s.recognized_gain} on a profitable deal`); break; }
    if (s.recognized_gain < Math.min(0, r.realized_gain) - 0.01) { fail(`${key}: recognized ${s.recognized_gain} below realized ${r.realized_gain}`); break; }
    if (s.recognized_gain > r.realized_gain + 0.01) { fail(`${key}: recognized ${s.recognized_gain} exceeds realized ${r.realized_gain}`); break; }
    if (s.total_tax < -0.01) { fail(`${key}: negative tax ${s.total_tax}`); break; }
    if (s.recognized_gain <= 0 && s.total_tax > 0.01) { fail(`${key}: tax ${s.total_tax} with no recognized gain`); break; }
  }
  if (r.unrecap_1250 > Math.max(0, r.realized_gain) + 0.01) fail(`unrecap_1250 ${r.unrecap_1250} exceeds realized gain`);
  if (failures) { console.log('  seed-reproducible case:', JSON.stringify({ status, ...POOL_SUBSET(inp) })); break; }
}
function POOL_SUBSET(i) { const o = {}; for (const k of Object.keys(POOL)) o[k] = i[k]; return o; }

if (!failures) console.log(`  PASS  every field finite and every identity held across ${N} deals`);

/* The specific mis-keys that used to print ($infinity). */
console.log('\n=== REGRESSION: mis-keyed divisors ===');
for (const [label, patch] of [
  ['Amort 0 (Levered)', { d_amort: 0 }],
  ['Amort 0 (all)', { b_amort: 0, b2_amort: 0, c_amort: 0, d_amort: 0 }],
  ['Recovery life 0', { recovery_life: 0 }],
  ['Term 0', { d_term: 0 }],
]) {
  const bad = nonFinite(compute({ ...DEFAULTS, ...patch }), '', []);
  if (bad.length) fail(`${label} -> ${bad.slice(0, 3).join(', ')}`);
  else console.log(`  PASS  ${label}: all finite`);
}

console.log('\n============================================');
console.log(failures === 0 ? 'ALL INVARIANTS HELD' : `${failures} INVARIANT FAILURE(S)`);
console.log('============================================');
process.exit(failures === 0 ? 0 : 1);
