/* ============================================================
   TKG 1031 Exchange & Financing Calculator — calculation engine
   Pure functions, top-to-bottom, no circular references, no deps.
   Wrapped in an IIFE so nothing leaks to global scope; exposed as
   window.Calc (browser) and module.exports (node, for the tests).

   2026 tax engine (MFJ): other income stacks first, then unrecaptured
   §1250 gain at 25%, then the LTCG layer across the 0/15/20 brackets.
   NIIT is capped by the MAGI-over-threshold rule; the MA 4% surtax is
   charged on the gain INCREMENT above the threshold only. Every rate
   and threshold is an editable input (section "Tax Rates & Thresholds").
   ============================================================ */
(function () {

/* Excel PMT: payment per period. Returns a NEGATIVE number (cash out). */
function PMT(rate, nper, pv) {
  if (rate === 0) return -pv / nper;
  return (-pv * rate) / (1 - Math.pow(1 + rate, -nper));
}

/* Default inputs — the 1214 Park deal, plus the 2026 tax table. */
const DEFAULTS = {
  /* ---- Report identity (print only; no effect on the math) ---- */
  prepared_for: '',
  property_address: '1214 Park Ave',

  /* ---- 1 · The property sale ---- */
  sale_price: 2355000,
  original_purchase_price: 500000,
  current_mortgage_payoff: 650000,

  /* ---- Capital improvements: lump sum placed in service in a given year ---- */
  capital_improvements: 0,
  improvement_year: 2016,       // year placed in service (improvement clock)
  improvement_years_held: 10,   // fallback for direct calc/test calls (app.js re-derives)

  /* ---- 2 · Depreciation ---- */
  land_pct: 0.20,               // default land share when no assessor split is entered
  assessed_land: 0,             // optional: assessor land value
  assessed_building: 0,         // optional: assessor building value (NEVER treated as improvements)
  recovery_life: 39,            // 39 commercial, 27.5 residential
  year_purchased: 2016,         // years_held derived in app.js (current year − this)
  years_held: 10,               // fallback for direct calc/test calls
  use_auto_depr: 1,             // 1 = auto straight-line; 0 = manual override wins
  manual_depreciation: 423900,  // used when use_auto_depr = 0

  /* ---- 3 · Income profile (never framed as "what is your income?") ---- */
  filing_status: 'mfj',         // mfj | single (thresholds below are MFJ; editable)
  income_profile: 'typical',    // moderate ($100k) | typical ($250k) | high ($600k) | custom
  other_taxable_income: 250000, // Typical profile default; drives bracket stacking + surtax base

  /* ---- 4 · Exchange sizing ---- */
  partial_pct: 0.50,            // Partial: share of equity reinvested
  partial_replace_debt: 1,      // 1 = new loan replaces the debt; 0 = pay it off (debt relief = boot)
  levered_pct: 1.25,            // Levered: buy up to this multiple of net sale price

  /* ---- Scenarios (A = Sell & Pay; B/B2 = two full exchanges; C/D below) ----
     Each exchange scenario carries an editable label, a show/hide flag, and
     its own replacement economics (cap rate / loan rate / term / amort).
     B and B2 are the SAME full exchange; only the replacement differs. Set them
     to whatever is being proposed (DST, NNN, multifamily, a development) and
     move the cap rate to match. The tax treatment is identical either way. */
  a_label: 'Sell & Pay',              a_note: 'pay the tax now',              a_show: 1,
  b_label: '1031 into DST',           b_note: 'passive, fractional',          b_show: 1,  b_yield: 0.0475, b_rate: 0.064, b_term: 15, b_amort: 30,
  b2_label: '1031 into NNN',          b2_note: 'single tenant, net lease',    b2_show: 1, b2_yield: 0.0625, b2_rate: 0.064, b2_term: 15, b2_amort: 30,
  c_label: 'Partial 1031',            c_note: 'reinvest part, keep the rest', c_show: 1,  c_yield: 0.0625, c_rate: 0.064, c_term: 15, c_amort: 30,
  d_label: 'Levered 1031',            d_note: 'trade up with new debt',       d_show: 1,  d_yield: 0.0725, d_rate: 0.064, d_term: 15, d_amort: 30,

  /* ---- 5 · Tax rates & thresholds (2026 MFJ; every one editable) ---- */
  rate_recapture: 0.25,         // unrecaptured §1250 gain, max 25%
  rate_ltcg_0: 0.00,            // 0% bracket
  rate_ltcg_15: 0.15,           // 15% bracket
  rate_ltcg: 0.20,              // 20% bracket (top)
  ltcg_bkt_0: 98900,            // 2026 MFJ 0%→15% breakpoint (taxable income)
  ltcg_bkt_1: 613700,           // 2026 MFJ 15%→20% breakpoint
  rate_niit: 0.038,             // IRC §1411
  niit_threshold: 250000,       // MFJ MAGI threshold
  // The band the printed report quotes instead of naming the client's income.
  report_income_lo: 100000,
  report_income_hi: 600000,
  ma_rate: 0.05,                // MA flat income tax
  ma_surtax_rate: 0.04,         // MA millionaire surtax
  ma_surtax_threshold: 1107750, // 2026 indexed, per return
  ordinary_rate: 0.37,          // top ordinary bracket; §1245 recapture

  /* ---- 6 · Advanced: cost segregation ---- */
  sec1245_depreciation: 0,
  cost_seg_flag: 0,

  /* ---- Transaction costs ---- */
  attorney_costs: 5000,
  transfer_rate: 2.28,          // MA deeds excise, $ per $500
  broker_pct: 0.06,
  fixed_fees: 540,
  prepay_penalty: 0,
};

/* Tax on an amount that sits as a layer on top of `base`, split across
   graduated brackets. brackets = [{upto, rate}, ...] ascending, last upto = Infinity.
   Returns { tax, parts:[{rate, amount, tax}] } where amount is how much of the
   layer fell in that bracket. */
function layeredBracketTax(base, amount, brackets) {
  const parts = [];
  let tax = 0;
  const lo = base;
  const hi = base + amount;
  let prev = 0;
  for (const b of brackets) {
    const seg = Math.max(0, Math.min(hi, b.upto) - Math.max(lo, prev));
    const t = seg * b.rate;
    parts.push({ rate: b.rate, amount: seg, tax: t });
    tax += t;
    prev = b.upto;
    if (prev >= hi) break;
  }
  return { tax, parts };
}

/* Effective land share: assessor split if both values are entered ("per
   assessor"), otherwise the default land_pct. */
function landInfo(i) {
  const al = i.assessed_land, ab = i.assessed_building;
  if (al > 0 && ab > 0) {
    return { land_pct: al / (al + ab), source: 'per assessor' };
  }
  return { land_pct: i.land_pct, source: 'default' };
}

/* Straight-line accumulated depreciation.
   - Building: original purchase price × (1 − land), over recovery_life, from acquisition.
   - Improvements: lump sum (100% depreciable, no land), over recovery_life, from the
     improvement in-service year — on their own clock.
   Fully depreciated once the asset's years held reaches its recovery life. */
function autoDepreciation(i, land_pct) {
  const buildingBasis = i.original_purchase_price * (1 - land_pct);
  const buildingAccum = i.years_held >= i.recovery_life
    ? buildingBasis
    : Math.min((buildingBasis / i.recovery_life) * i.years_held, buildingBasis);

  const imprBasis = i.capital_improvements; // improvements are 100% building
  const imprYears = (i.improvement_years_held != null) ? i.improvement_years_held : i.years_held;
  const imprAccum = imprYears >= i.recovery_life
    ? imprBasis
    : Math.min((imprBasis / i.recovery_life) * imprYears, imprBasis);

  return buildingAccum + imprAccum;
}

/* Hold economics for one scenario. p = { yield, rate, amort }. */
function holdEconomics(p, sz) {
  const noi = sz.replacement_value * p.yield;
  const annual_debt_service =
    sz.new_loan > 0 ? PMT(p.rate / 12, p.amort * 12, sz.new_loan) * 12 : 0;
  const net_cash_flow = noi + annual_debt_service; // debt service is negative
  const cash_on_cash = sz.equity_contributed ? net_cash_flow / sz.equity_contributed : 0;
  return { noi, annual_debt_service, net_cash_flow, cash_on_cash };
}

/* The whole model. Returns every derived value the UI/report needs. */
function compute(i) {
  // Shared transaction-cost block
  const broker_commission = i.sale_price * i.broker_pct;
  const ma_transfer_tax = (i.sale_price / 500) * i.transfer_rate;
  const transaction_costs =
    broker_commission + ma_transfer_tax + i.attorney_costs + i.fixed_fees + i.prepay_penalty;

  // Land share (assessor split or default) and depreciation
  const land = landInfo(i);
  const land_pct = land.land_pct;
  const auto_depreciation = autoDepreciation(i, land_pct);
  const accumulated_depreciation = i.use_auto_depr === 1 ? auto_depreciation : i.manual_depreciation;

  // Shared gain block
  const amount_realized = i.sale_price - transaction_costs;
  const adjusted_basis = i.original_purchase_price + i.capital_improvements - accumulated_depreciation;
  const realized_gain = amount_realized - adjusted_basis;
  const unrecap_1250 = Math.min(accumulated_depreciation, Math.max(0, realized_gain));

  const other = Math.max(0, i.other_taxable_income || 0);
  const ltcgBrackets = [
    { upto: i.ltcg_bkt_0, rate: i.rate_ltcg_0 },
    { upto: i.ltcg_bkt_1, rate: i.rate_ltcg_15 },
    { upto: Infinity, rate: i.rate_ltcg },
  ];

  // The Tax Engine — tax(recognized_gain)
  const zeroStack = {
    recognized_gain: 0, gain_recapture_layer: 0, gain_ltcg_layer: 0,
    tax_recapture: 0, ltcg_parts: [], tax_ltcg: 0,
    tax_niit: 0, tax_ma: 0, tax_surtax: 0, tax_1245: 0, total: 0,
  };
  const tax = (recognized_gain) => {
    // No recognized gain (deferred exchanges, or a loss) → no tax of any kind.
    if (recognized_gain <= 0) return { ...zeroStack };

    const gain_recapture_layer = Math.min(recognized_gain, unrecap_1250);
    const gain_ltcg_layer = recognized_gain - gain_recapture_layer;

    // §1250 unrecaptured gain at 25% (a flat max rate).
    const tax_recapture = gain_recapture_layer * i.rate_recapture;

    // LTCG layer stacks on top of (other income + the §1250 layer), then runs
    // through the 0 / 15 / 20 brackets.
    const base = other + gain_recapture_layer;
    const ltcgRes = layeredBracketTax(base, gain_ltcg_layer, ltcgBrackets);
    const tax_ltcg = ltcgRes.tax;

    // NIIT: 3.8% × min(recognized gain, MAGI over the threshold).
    const niit_base = Math.min(recognized_gain, Math.max(0, other + recognized_gain - i.niit_threshold));
    const tax_niit = niit_base * i.rate_niit;

    // MA 5% flat on the whole recognized gain.
    const tax_ma = recognized_gain * i.ma_rate;

    // MA 4% surtax on the gain INCREMENT above the threshold only — pre-existing
    // other income that is already over the line is not re-counted.
    const over_with = Math.max(0, other + recognized_gain - i.ma_surtax_threshold);
    const over_without = Math.max(0, other - i.ma_surtax_threshold);
    const tax_surtax = (over_with - over_without) * i.ma_surtax_rate;

    const tax_1245 = i.cost_seg_flag === 1 ? i.sec1245_depreciation * i.ordinary_rate : 0;

    const total = tax_recapture + tax_ltcg + tax_niit + tax_ma + tax_surtax + tax_1245;
    return {
      recognized_gain, gain_recapture_layer, gain_ltcg_layer,
      tax_recapture, ltcg_parts: ltcgRes.parts, tax_ltcg,
      tax_niit, tax_ma, tax_surtax, tax_1245, total,
    };
  };

  // Exchange sizing — full deferral replaces VALUE, EQUITY and DEBT.
  // Boot recognized = cash equity not reinvested + old debt not replaced by new debt.
  const equity_available = amount_realized - i.current_mortgage_payoff;
  const eq = Math.max(0, equity_available);
  const debt = i.current_mortgage_payoff;
  const recognizedFrom = (cash_boot, new_loan) =>
    Math.min(realized_gain, Math.max(0, cash_boot) + Math.max(0, debt - new_loan));

  // ---- A — Sell & Pay ----
  const taxA = tax(realized_gain);
  const A = {
    key: 'A', kind: 'sell', label: i.a_label, note: i.a_note, show: i.a_show !== 0,
    recognized_gain: realized_gain,
    total_tax: taxA.total,
    tax_breakdown: taxA,
    net_position: amount_realized - i.current_mortgage_payoff - taxA.total,
    tax_deferred: 0,
  };

  // ---- Full exchange (shared shape for B and B2): replace the full net value ----
  function fullExchange(key, label, note, show, econ) {
    const sz = {
      replacement_value: amount_realized,
      equity_contributed: eq,
      new_loan: Math.max(0, amount_realized - eq), // = debt, fully replaced
      cash_boot: 0,
    };
    const rec = recognizedFrom(sz.cash_boot, sz.new_loan);
    const tb = tax(rec);
    const eco = holdEconomics(econ, sz);
    return {
      key, kind: 'full', label, note, show: show !== 0, reinvest_pct: 1.0,
      ...sz, ...eco,
      yield: econ.yield, rate: econ.rate, amort: econ.amort,
      recognized_gain: rec, total_tax: tb.total, tax_breakdown: tb,
      return_metric: eco.cash_on_cash,
      net_position: sz.equity_contributed,
      tax_deferred: taxA.total - tb.total,
    };
  }
  const B = fullExchange('B', i.b_label, i.b_note, i.b_show,
    { yield: i.b_yield, rate: i.b_rate, amort: i.b_amort });
  const B2 = fullExchange('B2', i.b2_label, i.b2_note, i.b2_show,
    { yield: i.b2_yield, rate: i.b2_rate, amort: i.b2_amort });

  // ---- C — Partial: reinvest part of equity, optionally replace debt, take rest as cash ----
  const parEquity = i.partial_pct * eq;
  const parLoan = i.partial_replace_debt === 1 ? debt : 0;
  const szC = {
    replacement_value: parEquity + parLoan,
    equity_contributed: parEquity,
    new_loan: parLoan,
    cash_boot: Math.max(0, eq - parEquity),
  };
  const recC = recognizedFrom(szC.cash_boot, szC.new_loan);
  const taxC = tax(recC);
  const boot_cash_kept = szC.cash_boot - taxC.total;
  const ecoC = holdEconomics({ yield: i.c_yield, rate: i.c_rate, amort: i.c_amort }, szC);
  const C = {
    key: 'C', kind: 'partial', label: i.c_label, note: i.c_note, show: i.c_show !== 0,
    reinvest_pct: i.partial_pct,
    ...szC, ...ecoC,
    yield: i.c_yield, rate: i.c_rate, amort: i.c_amort,
    recognized_gain: recC, total_tax: taxC.total, tax_breakdown: taxC,
    return_metric: null,
    mortgage_boot: Math.max(0, debt - szC.new_loan),
    boot_cash_kept,
    net_position: szC.equity_contributed + boot_cash_kept,
    tax_deferred: taxA.total - taxC.total,
  };

  // ---- D — Levered: trade up to a multiple of net sale price ----
  const levValue = i.levered_pct * amount_realized;
  const szD = {
    replacement_value: levValue,
    equity_contributed: Math.min(eq, levValue),
    new_loan: Math.max(0, levValue - Math.min(eq, levValue)),
    cash_boot: 0,
  };
  const recD = recognizedFrom(szD.cash_boot, szD.new_loan);
  const taxD = tax(recD);
  const ecoD = holdEconomics({ yield: i.d_yield, rate: i.d_rate, amort: i.d_amort }, szD);

  // Levered depreciation (§1.168(i)-6 two-tier), with the fully-depreciated fix:
  // carryover tier = what's LEFT of the old depreciable basis, spread over the
  // REMAINING recovery period (0 once past the recovery life — never ÷ a floored 1).
  const depreciable_cost = (i.original_purchase_price + i.capital_improvements) * (1 - land_pct);
  const remaining_recovery = Math.max(0, i.recovery_life - i.years_held);
  const remaining_carryover_basis = Math.max(0, depreciable_cost - accumulated_depreciation);
  const carryover_annual = remaining_recovery > 0 ? remaining_carryover_basis / remaining_recovery : 0;
  const substituted_basis = szD.replacement_value - realized_gain;
  const depreciable_basis = substituted_basis * (1 - land_pct);
  const excess_dep_basis = Math.max(0, depreciable_basis - remaining_carryover_basis);
  const excess_annual = excess_dep_basis / i.recovery_life; // new money → fresh 39-yr clock
  const annual_depreciation = carryover_annual + excess_annual;
  const annual_tax_shield = annual_depreciation * i.ordinary_rate;
  const total_annual_benefit = ecoD.net_cash_flow + annual_tax_shield;
  const total_return_equity = szD.equity_contributed
    ? total_annual_benefit / szD.equity_contributed
    : 0;
  const D = {
    key: 'D', kind: 'levered', label: i.d_label, note: i.d_note, show: i.d_show !== 0,
    reinvest_pct: i.levered_pct,
    ...szD, ...ecoD,
    yield: i.d_yield, rate: i.d_rate, amort: i.d_amort,
    recognized_gain: recD, total_tax: taxD.total, tax_breakdown: taxD,
    substituted_basis, depreciable_basis,
    remaining_carryover_basis, remaining_recovery, carryover_annual,
    excess_dep_basis, excess_annual,
    annual_depreciation, annual_tax_shield, total_annual_benefit, total_return_equity,
    return_metric: total_return_equity,
    net_position: szD.equity_contributed,
    tax_deferred: taxA.total - taxD.total,
  };

  const scenarios = [A, B, B2, C, D];
  const visible = scenarios.filter((s) => s.show);

  return {
    inputs: i,
    broker_commission, ma_transfer_tax, transaction_costs,
    land_pct, land_source: land.source,
    auto_depreciation, accumulated_depreciation,
    amount_realized, adjusted_basis, realized_gain, unrecap_1250,
    equity_available, years_held: i.years_held, other_taxable_income: other,
    ltcg_brackets: ltcgBrackets,
    A, B, B2, C, D,
    scenarios, visible,
  };
}

/* Convenience: the recognized-tax stack at an arbitrary other-income level,
   for the "estimated tax by other income" table. Recomputes only the Sell &
   Pay stack (recognized = full realized gain). */
function taxAtIncome(baseInputs, otherIncome) {
  const r = compute({ ...baseInputs, other_taxable_income: otherIncome });
  return {
    other_income: otherIncome,
    realized_gain: r.realized_gain,
    tax_if_sold: r.A.total_tax,
    net_after_tax: r.A.net_position,
    tax_deferred_full: r.A.total_tax, // a full 1031 defers the entire Sell & Pay tax
    stack: r.A.tax_breakdown,
  };
}

/* 3.8 Financing Tool (standalone). mode: 'conventional' | 'io' */
function financing(f, mode) {
  const ltv = f.sale_price ? f.loan / f.sale_price : 0;
  const equity = f.sale_price - f.loan;
  const debt_service =
    mode === 'io'
      ? f.loan * f.rate * -1
      : PMT(f.rate / 12, f.amort_years * 12, f.loan) * 12;
  const dscr = debt_service ? f.noi / -debt_service : 0;
  const net_cash_flow = f.noi + debt_service;
  const cash_on_cash = equity ? net_cash_flow / equity : 0;
  return { ltv, equity, debt_service, dscr, net_cash_flow, cash_on_cash };
}

const FINANCING_DEFAULTS = {
  noi: 96714,
  sale_price: 1547421,
  loan: 1000000,
  term_years: 15,
  amort_years: 30,
  rate: 0.064,
};

const INCOME_PROFILES = { moderate: 100000, typical: 250000, high: 600000 };

const api = {
  PMT, DEFAULTS, compute, financing, FINANCING_DEFAULTS,
  layeredBracketTax, landInfo, autoDepreciation, taxAtIncome, INCOME_PROFILES,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.Calc = api;
})();
