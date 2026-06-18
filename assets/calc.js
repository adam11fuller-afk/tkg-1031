/* ============================================================
   TKG 1031 Exchange & Financing Calculator — calculation engine
   Direct, verbatim port of WEBSITE BUILD SPEC §3 (verified June 2026).
   Pure functions, top-to-bottom, no circular references.
   ============================================================ */

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
  years_held: 10,
  use_auto_depr: 1,
  manual_depreciation: 423900,
  // 2A-ter · Exchange sizing & replacement
  partial_pct: 0.50,
  levered_pct: 1.25,
  replacement_yield: 0.0625,
  replacement_rate: 0.064,
  replacement_term: 15,
  replacement_amort: 30,
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

/* Size a single 1031 scenario off the equity legally available to roll. (§3.4) */
function sizeScenario(pct, equity_available) {
  const replacement_value = pct * equity_available;
  const equity_contributed = Math.min(equity_available, replacement_value);
  const new_loan = Math.max(0, replacement_value - equity_contributed); // >0 only when buying up
  const cash_boot = Math.max(0, equity_available - replacement_value);   // >0 only when partial
  return { replacement_value, equity_contributed, new_loan, cash_boot };
}

/* Full / Levered hold economics (§3.6). */
function holdEconomics(i, sz) {
  const noi = sz.replacement_value * i.replacement_yield;
  const annual_debt_service =
    sz.new_loan > 0
      ? PMT(i.replacement_rate / 12, i.replacement_amort * 12, sz.new_loan) * 12
      : 0;
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

  // 3.4 Exchange sizing
  const equity_available = amount_realized - i.current_mortgage_payoff;
  // Underwater sale (payoff > proceeds) → no equity to roll. Clamp so the sizing
  // MIN/MAX rules don't manufacture phantom loans/boot on negative equity.
  const eq_for_sizing = Math.max(0, equity_available);
  const szFull = sizeScenario(1.0, eq_for_sizing);
  const szPartial = sizeScenario(i.partial_pct, eq_for_sizing);
  const szLevered = sizeScenario(i.levered_pct, eq_for_sizing);

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

  // ---- Scenario B — Full 1031 ----
  const ecoFull = holdEconomics(i, szFull);
  const B = {
    key: 'B',
    reinvest_pct: 1.0,
    ...szFull,
    recognized_gain: 0,
    total_tax: 0,
    tax_breakdown: tax(0),
    ...ecoFull,
    return_metric: ecoFull.cash_on_cash,
    net_position: szFull.equity_contributed,
    tax_deferred: taxA.total,
  };

  // ---- Scenario C — Partial 1031 (§3.7) ----
  const recognized_boot = Math.min(realized_gain, szPartial.cash_boot);
  const taxC = tax(recognized_boot);
  const boot_cash_kept = szPartial.cash_boot - taxC.total;
  const noiC = szPartial.replacement_value * i.replacement_yield;
  const C = {
    key: 'C',
    reinvest_pct: i.partial_pct,
    ...szPartial,
    recognized_gain: recognized_boot,
    total_tax: taxC.total,
    tax_breakdown: taxC,
    noi: noiC,
    annual_debt_service: 0,
    net_cash_flow: noiC, // no new debt assumed on partial
    cash_on_cash: null,  // not presented for partial (mixed cash-out + hold)
    return_metric: null,
    boot_cash_kept,
    net_position: szPartial.replacement_value + boot_cash_kept,
    tax_deferred: taxA.total - taxC.total,
  };

  // ---- Scenario D — Levered 1031 (§3.6 + carryover-basis depreciation) ----
  const ecoLev = holdEconomics(i, szLevered);
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
    recognized_gain: 0,
    total_tax: 0,
    tax_breakdown: tax(0),
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
    tax_deferred: taxA.total,
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
