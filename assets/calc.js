/* ============================================================
   TKG 1031 Exchange & Financing Calculator — calculation engine
   Direct, verbatim port of WEBSITE BUILD SPEC §3 (verified June 2026).
   Pure functions, top-to-bottom, no circular references.
   Wrapped in an IIFE so nothing leaks to global scope except window.Calc.
   ============================================================ */
(function () {

/* Excel PMT: payment per period. Returns a NEGATIVE number (cash out). */
function PMT(rate, nper, pv) {
  if (rate === 0) return -pv / nper;
  return (-pv * rate) / (1 - Math.pow(1 + rate, -nper));
}

/* Default inputs — taken verbatim from the spec (the 1214 Park deal). */
const DEFAULTS = {
  // 2A · True inputs
  sale_price: 2355000,
  original_purchase_price: 500000,
  capital_improvements: 0,
  current_mortgage_payoff: 650000,
  other_taxable_income: 0,
  // 2A-bis · Depreciation
  land_pct: 0.20,
  recovery_life: 39,
  year_purchased: 2016, // years_held is derived (current year − this) in app.js
  years_held: 10,       // fallback if year_purchased isn't synced (direct calc calls/tests)
  use_auto_depr: 1,
  manual_depreciation: 423900,
  // 2A-ter · Exchange sizing — how much equity each strategy rolls
  partial_pct: 0.50,
  partial_replace_debt: 1, // 1 = partial takes a new loan to replace the debt; 0 = pay off & take cash (debt relief is boot)
  levered_pct: 1.25,
  // Per-scenario replacement economics — product type (cap rate) and financing
  // (loan rate / term / amort) can differ by strategy.
  full_yield: 0.0625, full_rate: 0.064, full_term: 15, full_amort: 30,
  partial_yield: 0.0625, partial_rate: 0.064, partial_term: 15, partial_amort: 30,
  levered_yield: 0.0625, levered_rate: 0.064, levered_term: 15, levered_amort: 30,
  sec1245_depreciation: 0,
  // 2B · Rate / policy variables (verified June 2026)
  rate_recapture: 0.25,
  rate_ltcg: 0.20,
  rate_niit: 0.038,
  ma_rate: 0.05,
  ma_surtax_rate: 0.04,
  ma_surtax_threshold: 1107750,
  ordinary_rate: 0.37,
  cost_seg_flag: 0,
  // 2C · Transaction costs
  attorney_costs: 5000,
  transfer_rate: 2.28,
  broker_pct: 0.06,
  fixed_fees: 540,
  prepay_penalty: 0,
};

/* Hold economics for one scenario (§3.6). p = { yield, rate, amort }. */
function holdEconomics(p, sz) {
  const noi = sz.replacement_value * p.yield;
  const annual_debt_service =
    sz.new_loan > 0 ? PMT(p.rate / 12, p.amort * 12, sz.new_loan) * 12 : 0;
  const net_cash_flow = noi + annual_debt_service; // debt service is negative
  const cash_on_cash = sz.equity_contributed ? net_cash_flow / sz.equity_contributed : 0;
  return { noi, annual_debt_service, net_cash_flow, cash_on_cash };
}

/* The whole model. Returns every derived value the UI needs. */
function compute(i) {
  // 3.1 Shared transaction-cost block
  const broker_commission = i.sale_price * i.broker_pct;
  const ma_transfer_tax = (i.sale_price / 500) * i.transfer_rate;
  const transaction_costs =
    broker_commission + ma_transfer_tax + i.attorney_costs + i.fixed_fees + i.prepay_penalty;

  // Depreciation (§2A-bis)
  const depreciable_cost = (i.original_purchase_price + i.capital_improvements) * (1 - i.land_pct);
  const auto_depreciation = Math.min(
    (depreciable_cost / i.recovery_life) * i.years_held,
    depreciable_cost
  );
  const accumulated_depreciation = i.use_auto_depr === 1 ? auto_depreciation : i.manual_depreciation;

  // 3.2 Shared gain block
  const amount_realized = i.sale_price - transaction_costs;
  const adjusted_basis = i.original_purchase_price + i.capital_improvements - accumulated_depreciation;
  const realized_gain = amount_realized - adjusted_basis;
  const unrecap_1250 = Math.min(accumulated_depreciation, realized_gain);

  // 3.3 The Tax Engine — tax(recognized_gain)
  const tax = (recognized_gain) => {
    // No recognized gain (deferred exchanges B/D, or a loss) → no tax of any kind.
    // Gating here keeps §1245 recapture and the MA surtax-on-other-income out of the
    // $0-recognized scenarios, so their tax stack agrees with the $0 headline.
    if (recognized_gain <= 0) {
      return {
        recognized_gain: 0, gain_recapture_layer: 0, gain_ltcg_layer: 0,
        tax_recapture: 0, tax_ltcg: 0, tax_niit: 0, tax_ma: 0, tax_surtax: 0, tax_1245: 0, total: 0,
      };
    }
    const gain_recapture_layer = Math.min(recognized_gain, unrecap_1250);
    const gain_ltcg_layer = recognized_gain - gain_recapture_layer;
    const tax_recapture = gain_recapture_layer * i.rate_recapture;
    const tax_ltcg = gain_ltcg_layer * i.rate_ltcg;
    const tax_niit = recognized_gain * i.rate_niit;
    const tax_ma = recognized_gain * i.ma_rate;
    const tax_surtax =
      Math.max(0, i.other_taxable_income + recognized_gain - i.ma_surtax_threshold) * i.ma_surtax_rate;
    const tax_1245 = i.cost_seg_flag === 1 ? i.sec1245_depreciation * i.ordinary_rate : 0;
    const total = tax_recapture + tax_ltcg + tax_niit + tax_ma + tax_surtax + tax_1245;
    return {
      recognized_gain, gain_recapture_layer, gain_ltcg_layer,
      tax_recapture, tax_ltcg, tax_niit, tax_ma, tax_surtax, tax_1245, total,
    };
  };

  // 3.4 Exchange sizing — full deferral requires replacing VALUE, EQUITY, and DEBT.
  // Boot recognized = cash equity not reinvested  +  old debt not replaced by new debt.
  const equity_available = amount_realized - i.current_mortgage_payoff; // cash equity
  const eq = Math.max(0, equity_available);
  const debt = i.current_mortgage_payoff;                                // debt to replace
  const recognizedFrom = (cash_boot, new_loan) =>
    Math.min(realized_gain, Math.max(0, cash_boot) + Math.max(0, debt - new_loan));

  // ---- Scenario A — Sell & Pay (§3.5) ----
  const taxA = tax(realized_gain);
  const A = {
    key: 'A',
    recognized_gain: realized_gain,
    total_tax: taxA.total,
    tax_breakdown: taxA,
    net_position: amount_realized - i.current_mortgage_payoff - taxA.total, // net after-tax proceeds
    tax_deferred: 0,
  };

  // ---- Scenario B — Full 1031: replace the full net value (equity + new debt = old debt) ----
  const szFull = {
    replacement_value: amount_realized,
    equity_contributed: eq,
    new_loan: Math.max(0, amount_realized - eq), // = debt, fully replaced
    cash_boot: 0,
  };
  const recB = recognizedFrom(szFull.cash_boot, szFull.new_loan);
  const taxB = tax(recB);
  const ecoFull = holdEconomics({ yield: i.full_yield, rate: i.full_rate, amort: i.full_amort }, szFull);
  const B = {
    key: 'B',
    reinvest_pct: 1.0,
    ...szFull,
    recognized_gain: recB,
    total_tax: taxB.total,
    tax_breakdown: taxB,
    ...ecoFull,
    return_metric: ecoFull.cash_on_cash,
    net_position: szFull.equity_contributed,
    tax_deferred: taxA.total - taxB.total,
  };

  // ---- Scenario C — Partial 1031: reinvest part of equity, REPLACE the debt, take rest as cash ----
  const parEquity = i.partial_pct * eq;
  const parLoan = i.partial_replace_debt === 1 ? debt : 0; // replace debt, or pay it off (debt relief = boot)
  const szPartial = {
    replacement_value: parEquity + parLoan,
    equity_contributed: parEquity,
    new_loan: parLoan,
    cash_boot: Math.max(0, eq - parEquity),
  };
  const recognized_boot = recognizedFrom(szPartial.cash_boot, szPartial.new_loan);
  const taxC = tax(recognized_boot);
  const boot_cash_kept = szPartial.cash_boot - taxC.total;
  const ecoPartial = holdEconomics({ yield: i.partial_yield, rate: i.partial_rate, amort: i.partial_amort }, szPartial);
  const C = {
    key: 'C',
    reinvest_pct: i.partial_pct,
    ...szPartial,
    recognized_gain: recognized_boot,
    total_tax: taxC.total,
    tax_breakdown: taxC,
    ...ecoPartial,
    return_metric: null,  // mixed cash-out + hold; not shown
    mortgage_boot: Math.max(0, debt - szPartial.new_loan), // debt relief taxed when not replaced
    boot_cash_kept,
    net_position: szPartial.equity_contributed + boot_cash_kept,
    tax_deferred: taxA.total - taxC.total,
  };

  // ---- Scenario D — Levered 1031: trade up to a multiple of net sale price ----
  const levValue = i.levered_pct * amount_realized;
  const szLevered = {
    replacement_value: levValue,
    equity_contributed: Math.min(eq, levValue),
    new_loan: Math.max(0, levValue - Math.min(eq, levValue)),
    cash_boot: 0,
  };
  const recD = recognizedFrom(szLevered.cash_boot, szLevered.new_loan);
  const taxD = tax(recD);
  const ecoLev = holdEconomics({ yield: i.levered_yield, rate: i.levered_rate, amort: i.levered_amort }, szLevered);
  const substituted_basis = szLevered.replacement_value - realized_gain;
  const depreciable_basis = substituted_basis * (1 - i.land_pct);
  const carryover_dep_basis = adjusted_basis * (1 - i.land_pct);
  const excess_dep_basis = Math.max(0, depreciable_basis - carryover_dep_basis);
  const annual_depreciation =
    carryover_dep_basis / Math.max(1, i.recovery_life - i.years_held) +
    excess_dep_basis / i.recovery_life;
  const annual_tax_shield = annual_depreciation * i.ordinary_rate;
  const total_annual_benefit = ecoLev.net_cash_flow + annual_tax_shield;
  const total_return_equity = szLevered.equity_contributed
    ? total_annual_benefit / szLevered.equity_contributed
    : 0;
  const D = {
    key: 'D',
    reinvest_pct: i.levered_pct,
    ...szLevered,
    recognized_gain: recD,
    total_tax: taxD.total,
    tax_breakdown: taxD,
    ...ecoLev,
    substituted_basis,
    depreciable_basis,
    carryover_dep_basis,
    excess_dep_basis,
    annual_depreciation,
    annual_tax_shield,
    total_annual_benefit,
    total_return_equity,
    return_metric: total_return_equity,
    net_position: szLevered.equity_contributed,
    tax_deferred: taxA.total - taxD.total,
  };

  return {
    inputs: i,
    // shared / assumptions read-outs
    broker_commission,
    ma_transfer_tax,
    transaction_costs,
    auto_depreciation,
    accumulated_depreciation,
    amount_realized,
    adjusted_basis,
    realized_gain,
    unrecap_1250,
    equity_available,
    years_held: i.years_held,
    // scenarios
    A, B, C, D,
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

window.Calc = { PMT, DEFAULTS, compute, financing, FINANCING_DEFAULTS };
})();
