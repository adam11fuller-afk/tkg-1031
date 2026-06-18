/* ============================================================
   TKG 1031 Calculator — UI (rendering, live recompute, formatting)
   Wrapped in an IIFE: calc.js and app.js are both classic scripts sharing
   ONE global lexical scope, so a top-level `const DEFAULTS` (etc.) in both
   collides ("already declared") and silently kills app.js on real page load.
   ============================================================ */
(function () {
const { DEFAULTS, compute, financing, FINANCING_DEFAULTS } = window.Calc;
const CURRENT_YEAR = new Date().getFullYear();

/* ---------- state ---------- */
const STORAGE_KEY = 'tkg_1031_inputs';
const FIN_KEY = 'tkg_1031_financing';
let state = loadState(STORAGE_KEY, DEFAULTS);
let finState = loadState(FIN_KEY, FINANCING_DEFAULTS);

function loadState(key, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && typeof saved === 'object') return { ...fallback, ...saved };
  } catch (e) {}
  return { ...fallback };
}
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(FIN_KEY, JSON.stringify(finState));
  } catch (e) {}
}

/* ---------- formatting ---------- */
// currency: $#,##0 — parens for negatives, "-" for zero/null
function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const r = Math.round(v);
  if (r === 0) return '—';
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
function moneyZero(v) { // like money but shows $0 instead of dash (for inputs echo)
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const r = Math.round(v);
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
function pct(v, dp = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(dp) + '%';
}
// comma string for money <input> values (no $ — that's a prefix span)
function moneyInputStr(n) {
  const r = Math.round(n || 0);
  return r.toLocaleString('en-US');
}
// short labels for the chart: $1.55M / $551K / $0
function shortMoney(v) {
  if (!v) return '$0';
  const a = Math.abs(v);
  let s;
  if (a >= 1e6) s = '$' + (a / 1e6).toFixed(2) + 'M';
  else if (a >= 1e3) s = '$' + Math.round(a / 1e3) + 'K';
  else s = '$' + Math.round(a);
  return v < 0 ? '(' + s + ')' : s;
}

/* ---------- field definitions (mirror the workbook Assumptions tab) ---------- */
// type: money | pct | num | check ; pct values edited as whole percents (20 = 20%)
const SECTIONS = [
  {
    num: '1', title: 'THE PROPERTY SALE',
    desc: 'The basics of the property you’re selling. Start here.',
    fields: [
      ['sale_price', 'Estimated Sale Price', 'money', 'What you expect to sell the relinquished property for.'],
      ['original_purchase_price', 'Original Purchase Price', 'money', 'What you originally paid for it.'],
      ['capital_improvements', 'Capital Improvements', 'money', 'Capitalized improvements added to your basis.'],
      ['current_mortgage_payoff', 'Current Mortgage Payoff', 'money', 'Remaining loan balance paid off at closing.'],
    ],
  },
  {
    num: '2', title: 'DEPRECIATION',
    desc: 'Auto-calculate straight-line depreciation, or type your own figure. Toggle controls which is used.',
    fields: [
      ['land_pct', 'Land Value % (non-depreciable)', 'pct', 'Share of purchase price that is land. Land isn’t depreciable.'],
      ['recovery_life', 'Recovery Life (yrs)', 'num', '39 yr commercial, 27.5 yr residential.'],
      ['year_purchased', 'Year Purchased', 'num', 'The year you acquired the property. Years held is calculated from this.'],
      ['use_auto_depr', 'Use Auto Depreciation?', 'check', 'On = use the auto straight-line figure; off = use your manual number.'],
      ['manual_depreciation', 'Manual Accumulated Depreciation', 'money', 'Used only when Auto is switched off.'],
    ],
    calc: [
      ['years_held', 'Years Held (calculated)', 'yrs'],
      ['auto_depreciation', 'Auto Straight-Line Depreciation'],
      ['accumulated_depreciation', 'Accumulated Depreciation (used)'],
    ],
  },
  {
    num: '3', title: 'SELLING COSTS',
    desc: 'Fees and taxes to close the sale. Defaults are typical Massachusetts figures.',
    fields: [
      ['broker_pct', 'Broker Commission %', 'pct', 'Sale commission as % of price. Typically 5–6%.'],
      ['transfer_rate', 'MA Transfer Tax ($ per $500)', 'num', 'MA deeds excise: $2.28 per $500. Applies even in a 1031.', 0.01],
      ['attorney_costs', 'Attorney Closing Costs', 'money', 'Legal fees, recording, title.'],
      ['fixed_fees', 'Fixed Fees (UCC, escrow, filing)', 'money', 'Flat closing fees — a dollar amount, not a %. $300–700 typical.'],
      ['prepay_penalty', 'Mortgage Prepayment Penalty', 'money', 'Early-payoff penalty, if any.'],
    ],
  },
  {
    num: '4', title: '1031 EXCHANGE SIZING & REPLACEMENT',
    desc: 'How much equity each strategy rolls, and the new property’s economics. Cap rate and financing can differ by scenario since the replacement product may differ.',
    fields: [
      ['partial_pct', 'Partial — % of equity reinvested', 'pct', 'How much available equity rolls into the new property; the rest is taxable boot.'],
      ['levered_pct', 'Levered — % of equity (buy-up)', 'pct', 'Buy a property worth this multiple of available equity; the gap is financed.'],
    ],
    matrix: true,
  },
  {
    num: '5', title: 'TAX RATES (verified 2026 — rarely change)',
    desc: 'Tax-law constants. Pre-filled and verified June 2026. A CPA can override; a normal user never touches these.',
    collapsible: true, collapsed: true,
    fields: [
      ['rate_ltcg', 'Federal LTCG rate', 'pct', 'IRC §1(h).'],
      ['rate_recapture', 'Depreciation Recapture rate', 'pct', 'Unrecaptured §1250, up to 25%.'],
      ['rate_niit', 'NIIT rate', 'pct', 'Net Investment Income Tax, IRC §1411.'],
      ['ma_rate', 'MA Capital Gains rate', 'pct', 'MA flat 5.0%.'],
      ['ma_surtax_rate', 'MA 4% Surtax rate', 'pct', 'M.G.L. c.62 §4(d).'],
      ['ma_surtax_threshold', 'MA Surtax Threshold', 'money', '2026 indexed, per return.'],
      ['ordinary_rate', 'Ordinary Income rate', 'pct', 'Top bracket; §1245 recapture.'],
    ],
  },
  {
    num: '6', title: 'ADVANCED — COST SEGREGATION',
    desc: 'Only if cost-seg was done. Leave at defaults otherwise.',
    collapsible: true, collapsed: true,
    fields: [
      ['sec1245_depreciation', '§1245 / Cost-Seg Depreciation', 'money', 'Personal-property components recaptured at ordinary rate.'],
      ['other_taxable_income', 'Other Taxable Income', 'money', 'Your other MA income — sets the surtax base.'],
      ['cost_seg_flag', 'Recapture §1245 at ordinary rate?', 'check', 'On = add §1245 recapture to the tax stack.'],
    ],
  },
];

/* ---------- input <-> state conversion ---------- */
function toDisplay(key, type) {
  const v = state[key];
  if (type === 'pct') return +(v * 100).toFixed(4);
  return v;
}

// build one input cell (shared by money/pct/num)
function inputCell(key, type, value, step, dataAttr, label) {
  const unit = type === 'money' ? ' (dollars)' : type === 'pct' ? ' (percent)' : '';
  const aria = label ? ` id="f-${key}" aria-label="${label.replace(/"/g, '')}${unit}"` : '';
  const pre = type === 'money' ? '<span class="pre">$</span>' : '';
  const post = type === 'pct' ? '<span class="post">%</span>' : '';
  if (type === 'money') {
    return `<div class="input-wrap">${pre}<input type="text" inputmode="numeric"${aria} ${dataAttr}="${key}" data-type="money" value="${moneyInputStr(value)}"/>${post}</div>`;
  }
  const stp = step || (type === 'pct' ? 0.1 : 1);
  return `<div class="input-wrap">${pre}<input type="number" min="0" step="${stp}"${aria} ${dataAttr}="${key}" data-type="${type}" value="${value}"/>${post}</div>`;
}

/* per-scenario replacement matrix (cap rate / loan rate / term / amort) */
function matrixCell(key, type) {
  const value = type === 'pct' ? +(state[key] * 100).toFixed(4) : state[key];
  const stp = type === 'pct' ? 0.05 : 1;
  return `<input class="mx-in" type="number" min="0" step="${stp}" data-key="${key}" data-type="${type}" value="${value}" aria-label="${key}"/>`;
}
function replacementMatrix() {
  const rows = [['Full 1031', 'full'], ['Partial 1031', 'partial'], ['Levered 1031', 'levered']];
  const body = rows.map(([label, k]) => `<tr>
      <td class="mx-lbl">${label}</td>
      <td>${matrixCell(k + '_yield', 'pct')}</td>
      <td>${matrixCell(k + '_rate', 'pct')}</td>
      <td>${matrixCell(k + '_term', 'num')}</td>
      <td>${matrixCell(k + '_amort', 'num')}</td>
    </tr>`).join('');
  return `<div class="mx-wrap">
    <div class="mx-title">Replacement assumptions by scenario</div>
    <table class="mx-table">
      <thead><tr><th>Scenario</th><th>Cap Rate %</th><th>Loan Rate %</th><th>Term (yr)</th><th>Amort (yr)</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="mx-note">Cap rate drives each scenario’s NOI. Loan rate / term / amort apply where a scenario carries new debt (Levered by default); Full &amp; Partial assume no new loan.</p>
  </div>`;
}

/* ---------- render: Assumptions ---------- */
function renderAssumptions() {
  const root = document.getElementById('view-assumptions');
  let html = '';
  for (const sec of SECTIONS) {
    const cls = 'card' + (sec.collapsible ? ' collapsible' : '') + (sec.collapsed ? ' collapsed' : '');
    html += `<div class="${cls}" data-sec="${sec.num}">
      <div class="sec-head" ${sec.collapsible ? `data-toggle="1" role="button" tabindex="0" aria-expanded="${sec.collapsed ? 'false' : 'true'}"` : ''}>
        <span><span class="num">${sec.num} ·</span>${sec.title}</span>
        ${sec.collapsible ? '<span class="chevron">▾</span>' : ''}
      </div>
      <div class="body">
        <p class="sec-desc">${sec.desc}</p>`;
    for (const f of sec.fields) {
      const [key, label, type, help, step] = f;
      if (type === 'check') {
        html += `<div class="field"><div class="lbl">${label}<span class="help">${help}</span></div>
          <label class="switch"><input type="checkbox" aria-label="${label}" data-key="${key}" data-type="check" ${state[key] ? 'checked' : ''}/> <span>${state[key] ? 'On' : 'Off'}</span></label></div>`;
      } else {
        const value = type === 'pct' ? toDisplay(key, type) : state[key];
        html += `<div class="field"><div class="lbl">${label}<span class="help">${help}</span></div>
          ${inputCell(key, type, value, step, 'data-key', label)}</div>`;
      }
    }
    if (sec.matrix) html += replacementMatrix();
    if (sec.calc) {
      html += `<div style="height:6px"></div>`;
      for (const [k, lbl, fmt] of sec.calc) {
        html += `<div class="calc-row"><div class="lbl">${lbl}</div><div class="val" data-calc="${k}" data-fmt="${fmt || 'money'}">—</div></div>`;
      }
    }
    html += `</div></div>`;
  }

  // Calculated read-out card (transparency)
  html += `<div class="card calc-card"><div class="sec-head">CALCULATED — THE TAXABLE GAIN</div>
    <div class="body">
      <div class="calc-row"><div class="lbl">Total Selling Costs</div><div class="val" data-calc="transaction_costs">—</div></div>
      <div class="calc-row"><div class="lbl">Amount Realized (price − costs)</div><div class="val" data-calc="amount_realized">—</div></div>
      <div class="calc-row"><div class="lbl">Adjusted Basis</div><div class="val" data-calc="adjusted_basis">—</div></div>
      <div class="calc-row"><div class="lbl">Realized Gain</div><div class="val" data-calc="realized_gain">—</div></div>
      <div class="calc-row hero"><div class="lbl">Equity Available to Exchange</div><div class="val" data-calc="equity_available">—</div></div>
    </div></div>`;

  root.innerHTML = html;
  wireInputs(root, 'data-key', () => recompute());
  root.querySelectorAll('[data-toggle]').forEach((el) => {
    const toggle = () => {
      const collapsed = el.closest('.card').classList.toggle('collapsed');
      el.setAttribute('aria-expanded', String(!collapsed));
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

/* shared input wiring: live recompute, comma reformat for money on blur */
function wireInputs(root, attr, onChange) {
  const stateObj = attr === 'data-key' ? state : finState;
  root.querySelectorAll('input').forEach((el) => {
    const type = el.dataset.type;
    const key = el.getAttribute(attr);
    if (!key) return;
    el.addEventListener('input', () => {
      if (type === 'check') {
        stateObj[key] = el.checked ? 1 : 0;
        if (el.nextElementSibling) el.nextElementSibling.textContent = el.checked ? 'On' : 'Off';
      } else {
        // Ignore incomplete intermediate states ('', '-', '.', '-.') so the model
        // doesn't flip to 0 mid-edit; it commits on the next valid keystroke.
        if (/^-?\.?$/.test(el.value)) return;
        setFromInput(stateObj, key, type, el.value);
      }
      onChange();
    });
    if (type === 'money') {
      el.addEventListener('focus', () => el.select());
      el.addEventListener('blur', () => {
        stateObj[key] = Math.round(stateObj[key] || 0); // keep stored value == displayed value
        el.value = moneyInputStr(stateObj[key]);
      });
    }
  });
}
function setFromInput(obj, key, type, raw) {
  let n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  if (Number.isNaN(n)) n = 0;
  obj[key] = type === 'pct' ? n / 100 : n;
}

/* ---------- chart: net proceeds + tax + annual net income (combined) ---------- */
function chartSVG(r) {
  const items = [
    { name: 'Sell & Pay', net: r.A.net_position, tax: r.A.total_tax, inc: 0, noInc: true },
    { name: 'Full 1031', net: r.B.net_position, tax: r.B.total_tax, inc: r.B.net_cash_flow },
    { name: 'Partial 1031', net: r.C.net_position, tax: r.C.total_tax, inc: r.C.net_cash_flow },
    { name: 'Levered 1031', net: r.D.net_position, tax: r.D.total_tax, inc: r.D.net_cash_flow },
  ];
  const W = 720, H = 300, padL = 12, padR = 12, padT = 34, padB = 46;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const max = Math.max(1, ...items.flatMap((d) => [Math.abs(d.net), Math.abs(d.tax), Math.abs(d.inc)]));
  const groupW = (W - padL - padR) / items.length;
  const barW = 30, gap = 5;
  const NAVY = '#002855', ORANGE = '#ff7f32', TEAL = '#1d9e75';
  const bar = (x, val, color) => {
    if (!(val > 0)) return '';
    const h = Math.max(0, (val / max) * plotH);
    return `<rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="2" fill="${color}"/>` +
      `<text x="${(x + barW / 2).toFixed(1)}" y="${(baseY - h - 5).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${color}">${shortMoney(val)}</text>`;
  };
  let bars = '';
  items.forEach((d, i) => {
    const gc = padL + groupW * (i + 0.5);
    const x0 = gc - (barW * 3 + gap * 2) / 2;
    bars += bar(x0, d.net, NAVY);
    bars += bar(x0 + barW + gap, d.tax, ORANGE);
    if (!d.noInc) bars += bar(x0 + 2 * (barW + gap), d.inc, TEAL);
    bars += `<text x="${gc.toFixed(1)}" y="${(baseY + 18).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="${NAVY}">${d.name}</text>`;
  });
  const legend = `
    <rect x="12" y="6" width="11" height="11" rx="2" fill="${NAVY}"/><text x="27" y="15" font-size="11.5" fill="#5a6b7b">Net Proceeds / Position</text>
    <rect x="192" y="6" width="11" height="11" rx="2" fill="${ORANGE}"/><text x="207" y="15" font-size="11.5" fill="#5a6b7b">Tax Due</text>
    <rect x="262" y="6" width="11" height="11" rx="2" fill="${TEAL}"/><text x="277" y="15" font-size="11.5" fill="#5a6b7b">Annual Net Income (after debt)</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Net proceeds, tax due, and annual net income by scenario" preserveAspectRatio="xMidYMid meet" style="font-family:Calibri,system-ui,sans-serif">
    <line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="#d7e0ea" stroke-width="1"/>
    ${legend}
    ${bars}
  </svg>`;
}

/* ---------- render: Summary ---------- */
function renderSummary(r) {
  const root = document.getElementById('view-summary');
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const names = ['Sell &amp; Pay', 'Full 1031', 'Partial 1031', 'Levered 1031'];

  const row = (label, vals, opts = {}) => {
    if (opts.section) return `<tr class="section"><td colspan="5">${label}</td></tr>`;
    const classes = [];
    if (opts.strong) classes.push('strong');
    if (opts.subtle) classes.push('subtle');
    if (opts.bottom) classes.push('bottom');
    if (opts.how) classes.push('howrow');
    if (opts.hi) classes.push('hi');
    return `<tr class="${classes.join(' ')}"><td>${label}</td>${vals.map((v) => `<td>${v}</td>`).join('')}</tr>`;
  };

  let html = `
  <div class="print-header">
    <div class="ph-brand">MARCUS &amp; MILLICHAP&nbsp;&nbsp;|&nbsp;&nbsp;THE KLEIN GROUP</div>
    <div class="ph-sub">1031 Exchange &amp; Financing Analysis &nbsp;·&nbsp; Prepared ${dateStr}</div>
  </div>
  <div class="sum-head">
    <button class="btn-print no-print" onclick="window.print()" title="Print or save the client summary as PDF">⎙ Print / Save PDF</button>
    <h2 class="sum-title">Client Summary</h2>
    <p class="sum-sub">1031 Exchange &amp; Financing Analysis</p>
    <p class="sum-note">Estimates only — confirm with your CPA &amp; attorney.</p>
  </div>

  <div class="bridge">
    <div class="bridge-item"><span class="bl">Sale Price</span><span class="bv">${money(r.inputs.sale_price)}</span></div>
    <div class="bridge-op">−</div>
    <div class="bridge-item"><span class="bl">Selling Costs</span><span class="bv">${money(r.transaction_costs)}</span></div>
    <div class="bridge-op">−</div>
    <div class="bridge-item"><span class="bl">Mortgage Payoff</span><span class="bv">${money(r.inputs.current_mortgage_payoff)}</span></div>
    <div class="bridge-op">=</div>
    <div class="bridge-item total"><span class="bl">Equity Available to Exchange</span><span class="bv">${money(r.equity_available)}</span></div>
  </div>

  <table class="summary">
    <thead><tr><th>Scenario</th>${names.map((n) => `<th>${n}</th>`).join('')}</tr></thead>
    <tbody>
      ${row('THE EXCHANGE MATH', null, { section: true })}
      ${row('Reinvestment / Buy-Up %', ['—', pct(r.B.reinvest_pct), pct(r.C.reinvest_pct), pct(r.D.reinvest_pct)])}
      ${row('New Property Value', ['—', money(r.B.replacement_value), money(r.C.replacement_value), money(r.D.replacement_value)], { strong: true })}
      ${row('Equity Put Into Property', ['—', money(r.B.equity_contributed), money(r.C.equity_contributed), money(r.D.equity_contributed)])}
      ${row('New Loan (auto-sized)', ['—', money(r.B.new_loan), '—', money(r.D.new_loan)])}
      ${row('Cash Boot Taken (taxed)', ['—', '—', money(r.C.cash_boot), '—'])}

      ${row('THE TAX', null, { section: true })}
      ${row('Realized Gain', [money(r.realized_gain), money(r.realized_gain), money(r.realized_gain), money(r.realized_gain)])}
      ${row('Gain Recognized (taxed now)', [money(r.A.recognized_gain), '—', money(r.C.recognized_gain), '—'])}
      ${row('Total Tax Due This Year', [money(r.A.total_tax), '—', money(r.C.total_tax), '—'], { strong: true, subtle: true })}
      ${row('Tax Deferred vs. Selling', ['—', money(r.B.tax_deferred), money(r.C.tax_deferred), money(r.D.tax_deferred)])}

      ${row('THE NEW INCOME', null, { section: true })}
      ${row('Annual NOI (new property)', ['—', money(r.B.noi), money(r.C.noi), money(r.D.noi)])}
      ${row('Net Cash Flow After Debt', ['—', money(r.B.net_cash_flow), money(r.C.net_cash_flow), money(r.D.net_cash_flow)], { hi: true })}

      ${row('Net Proceeds / Position', [money(r.A.net_position), money(r.B.net_position), money(r.C.net_position), money(r.D.net_position)], { bottom: true })}
    </tbody>
  </table>

  <div class="card chart-card"><div class="sec-head">AT A GLANCE</div>
    <div class="body chart-body">${chartSVG(r)}</div>
  </div>

  <div id="warn-box" class="warnings"></div>

  <p class="footnote">Tax rates verified June 2026 (Fed ${pct(r.inputs.rate_ltcg, 0)} LTCG · ${pct(r.inputs.rate_recapture, 0)} recapture · ${pct(r.inputs.rate_niit)} NIIT · MA ${pct(r.inputs.ma_rate, 0)} + ${pct(r.inputs.ma_surtax_rate, 0)} surtax over ${money(r.inputs.ma_surtax_threshold)}). §1031 needs 45-day ID / 180-day close.</p>

  <div class="disclaimer"><strong>Disclaimer.</strong> Estimates only — confirm with your accountant and attorney. §1031 deferral requires replacing value, equity, AND debt, plus the 45-day identification / 180-day closing deadlines; this model assumes a qualifying exchange. The §1.168(i)-6 election (Levered) and §1245 cost-seg recapture require CPA sign-off for a specific deal. The MA 4% surtax is computed on your other taxable income plus the recognized gain — enter accurate other income for a correct estimate.</div>
  <div class="print-footer">Marcus &amp; Millichap | The Klein Group &nbsp;·&nbsp; 1031 Exchange &amp; Financing Analysis &nbsp;·&nbsp; Estimates only — confirm with your CPA &amp; attorney &nbsp;·&nbsp; Prepared ${dateStr}</div>
  `;
  root.innerHTML = html;

  const warns = [];
  if (r.equity_available < 0)
    warns.push('Mortgage payoff exceeds net sale proceeds — there is no equity available to exchange, so the 1031 scenarios show $0.');
  if (r.B.replacement_value < r.inputs.sale_price)
    warns.push('Full 1031 replacement value is below the relinquished sale price — replacing less value can break full §1031 deferral.');
  if (r.D.replacement_value < r.inputs.sale_price)
    warns.push('Levered replacement value is below the relinquished sale price — check that value, equity, and debt are fully replaced.');
  if (r.C.cash_boot > 0)
    warns.push('Partial exchange takes cash boot — that portion is taxable this year (recapture layer first).');
  const wb = document.getElementById('warn-box');
  wb.innerHTML = warns.map((w) => `<div class="warn">⚠︎ ${w}</div>`).join('');
}

/* ---------- render: Scenario Detail (A/B/C/D) ---------- */
function taxStack(tb, costSeg) {
  const r = (label, sub, val) =>
    `<div class="tx-row"><div class="tx-lbl">${label}${sub ? `<span class="tx-sub">${sub}</span>` : ''}</div><div class="tx-val">${money(val)}</div></div>`;
  const sub = (v, txt) => (v > 0 ? txt : '');
  let rows =
    r('§1250 Recapture · 25%', sub(tb.gain_recapture_layer, `on ${money(tb.gain_recapture_layer)} layer`), tb.tax_recapture) +
    r('Federal LTCG · 20%', sub(tb.gain_ltcg_layer, `on ${money(tb.gain_ltcg_layer)} layer`), tb.tax_ltcg) +
    r('NIIT · 3.8%', sub(tb.recognized_gain, `on ${money(tb.recognized_gain)} recognized`), tb.tax_niit) +
    r('MA Income · 5.0%', '', tb.tax_ma) +
    r('MA 4% Surtax', sub(tb.tax_surtax, 'over the threshold'), tb.tax_surtax);
  if (costSeg) rows += r('§1245 Recapture · ordinary', 'cost-seg personal property', tb.tax_1245);
  rows += `<div class="tx-row tx-total"><div class="tx-lbl">Total Tax Due This Year</div><div class="tx-val">${money(tb.total)}</div></div>`;
  return rows;
}
function detailRow(label, val, opts = {}) {
  const cls = 'd-row' + (opts.hero ? ' hero' : '') + (opts.strong ? ' strong' : '');
  return `<div class="${cls}"><div class="d-lbl">${label}</div><div class="d-val">${val}</div></div>`;
}
function scenarioCard(scn, r) {
  const meta = {
    A: { name: 'Sell &amp; Pay', tag: 'Sell now, pay the full tax', cls: 'scn-a' },
    B: { name: 'Full §1031', tag: 'Defer 100%, no cash out', cls: 'scn-b' },
    C: { name: 'Partial §1031', tag: 'Exchange + take some cash', cls: 'scn-c' },
    D: { name: 'Leveraged §1031', tag: 'Trade up with new debt', cls: 'scn-d' },
  }[scn.key];
  const deferred = scn.key === 'B' || scn.key === 'D';

  let position = '';
  if (scn.key === 'A') {
    position =
      detailRow('Amount Realized', money(r.amount_realized)) +
      detailRow('Less: Mortgage Payoff', money(-r.inputs.current_mortgage_payoff)) +
      detailRow('Less: Total Tax', money(-scn.total_tax)) +
      detailRow('Net After-Tax Proceeds', money(scn.net_position), { hero: true });
  } else if (scn.key === 'B') {
    position =
      detailRow('New Property Value', money(scn.replacement_value), { strong: true }) +
      detailRow('Equity Invested', money(scn.equity_contributed)) +
      detailRow('New Loan', money(scn.new_loan)) +
      detailRow('Annual NOI', money(scn.noi)) +
      detailRow('Net Cash Flow After Debt', money(scn.net_cash_flow)) +
      detailRow('Equity Position', money(scn.net_position), { hero: true });
  } else if (scn.key === 'C') {
    position =
      detailRow('New Property Value', money(scn.replacement_value), { strong: true }) +
      detailRow('Equity Reinvested (deferred)', money(scn.equity_contributed)) +
      detailRow('Cash Boot Taken', money(scn.cash_boot)) +
      detailRow('Less: Tax on Boot', money(-scn.total_tax)) +
      detailRow('Boot Cash Kept', money(scn.boot_cash_kept)) +
      detailRow('Annual NOI', money(scn.noi)) +
      detailRow('Total Position (equity + cash)', money(scn.net_position), { hero: true });
  } else {
    position =
      detailRow('New Property Value', money(scn.replacement_value), { strong: true }) +
      detailRow('Equity Invested', money(scn.equity_contributed)) +
      detailRow('New Loan (buy-up gap)', money(scn.new_loan)) +
      detailRow('Annual NOI', money(scn.noi)) +
      detailRow('Annual Debt Service', money(scn.annual_debt_service)) +
      detailRow('Net Cash Flow After Debt', money(scn.net_cash_flow)) +
      `<div class="d-sub">DEPRECIATION SHIELD (§1031(d) carryover basis)</div>` +
      detailRow('Annual Depreciation', money(scn.annual_depreciation)) +
      detailRow('Annual Tax Shield', money(scn.annual_tax_shield)) +
      detailRow('Total Annual Benefit', money(scn.total_annual_benefit)) +
      detailRow('Return on Equity', pct(scn.total_return_equity)) +
      detailRow('Equity Position', money(scn.net_position), { hero: true });
  }

  const deferBanner = deferred
    ? `<div class="defer-banner">All gain deferred — $0 recognized this year (${money(scn.tax_deferred)} tax deferred vs. selling)</div>`
    : '';

  return `<div class="scn-card ${meta.cls}">
    <div class="scn-head">
      <div><span class="scn-key">${scn.key}</span><span class="scn-name">${meta.name}</span></div>
      <span class="scn-tag">${meta.tag}</span>
    </div>
    <div class="scn-body">
      <div class="scn-grp">THE GAIN</div>
      ${detailRow('Realized Gain', money(r.realized_gain))}
      ${detailRow('Gain Recognized (taxed now)', money(scn.recognized_gain), { strong: true })}
      <div class="scn-grp">THE TAX STACK</div>
      ${deferBanner}
      ${taxStack(scn.tax_breakdown, r.inputs.cost_seg_flag === 1)}
      <div class="scn-grp">${scn.key === 'A' ? 'WHAT YOU WALK AWAY WITH' : 'WHAT YOU REINVEST / WALK AWAY WITH'}</div>
      ${position}
    </div>
  </div>`;
}
function renderScenarios(r) {
  const root = document.getElementById('view-scenarios');
  root.innerHTML = `
    <div class="sum-head">
      <h2 class="sum-title">Scenario Detail</h2>
      <p class="sum-sub">The full tax stack and economics behind each option</p>
      <p class="sum-note">Read-only — every figure derives from the Assumptions tab. Recapture is taxed first, then long-term capital gains.</p>
    </div>
    <div class="scn-grid">
      ${scenarioCard(r.A, r)}
      ${scenarioCard(r.B, r)}
      ${scenarioCard(r.C, r)}
      ${scenarioCard(r.D, r)}
    </div>`;
}

/* ---------- render: Financing Tool ---------- */
const FIN_FIELDS = [
  ['noi', 'Net Operating Income (NOI)', 'money'],
  ['sale_price', 'Property / Sale Price', 'money'],
  ['loan', 'Loan Amount', 'money'],
  ['term_years', 'Loan Term (yrs) — balloon', 'num'],
  ['amort_years', 'Amortization (yrs)', 'num'],
  ['rate', 'Interest Rate', 'pct'],
];
function renderFinancing() {
  const root = document.getElementById('view-financing');
  let inputsHtml = '';
  for (const [key, label, type] of FIN_FIELDS) {
    const value = type === 'pct' ? +(finState[key] * 100).toFixed(4) : finState[key];
    inputsHtml += `<div class="field"><div class="lbl">${label}</div>${inputCell(key, type, value, undefined, 'data-fkey', label)}</div>`;
  }

  root.innerHTML = `
    <div class="card"><div class="sec-head"><span><span class="num">·</span>FINANCING INPUTS</span></div>
      <div class="body"><p class="sec-desc">Standalone debt sizing — independent of the exchange logic. The same NOI, price, loan, and rate feed both the conventional (amortizing) and interest-only views.</p>${inputsHtml}</div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="sec-head">CONVENTIONAL (AMORTIZING)</div><div id="fin-conv" class="fin-out"></div></div>
      <div class="card"><div class="sec-head">INTEREST-ONLY</div><div id="fin-io" class="fin-out"></div></div>
    </div>
    <p class="footnote">Payment uses the monthly convention: PMT(rate/12, amort×12, loan) × 12. Term is the balloon/maturity and does not drive the payment.</p>
  `;
  wireInputs(root, 'data-fkey', () => recomputeFinancing());
  recomputeFinancing();
}
function finBlock(o) {
  return `
    <div class="k">LTV</div><div class="v">${pct(o.ltv)}</div>
    <div class="k">Equity Required</div><div class="v">${money(o.equity)}</div>
    <div class="k">Annual Debt Service</div><div class="v">${money(o.debt_service)}</div>
    <div class="k">DSCR</div><div class="v">${o.dscr ? o.dscr.toFixed(2) + 'x' : '—'}</div>
    <div class="k">Net Cash Flow</div><div class="v hi">${money(o.net_cash_flow)}</div>
    <div class="k">Cash-on-Cash</div><div class="v hi">${pct(o.cash_on_cash)}</div>`;
}
function recomputeFinancing() {
  document.getElementById('fin-conv').innerHTML = finBlock(financing(finState, 'conventional'));
  document.getElementById('fin-io').innerHTML = finBlock(financing(finState, 'io'));
  saveState();
}

/* ---------- Saved deals (save / load / compare) ---------- */
const DEALS_KEY = 'tkg_1031_deals';
let deals = loadDeals();
const compareSel = new Set(); // selected deal ids

function loadDeals() {
  try { const d = JSON.parse(localStorage.getItem(DEALS_KEY)); return Array.isArray(d) ? d : []; }
  catch (e) { return []; }
}
function persistDeals() { try { localStorage.setItem(DEALS_KEY, JSON.stringify(deals)); } catch (e) {} }
function nextDealId() { return deals.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1; }
function escHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function saveDeal(name) {
  name = (name || '').trim() || 'Deal ' + (deals.length + 1);
  const existing = deals.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.inputs = { ...state };
  else deals.push({ id: nextDealId(), name, inputs: { ...state } });
  persistDeals();
  renderSavedDeals();
}
function loadDealById(id) {
  const d = deals.find((x) => x.id === id);
  if (!d) return;
  state = { ...DEFAULTS, ...d.inputs };
  renderAssumptions();
  recompute();
  document.querySelector('#tabs button[data-tab="summary"]').click();
}
function deleteDealById(id) {
  deals = deals.filter((d) => d.id !== id);
  compareSel.delete(id);
  persistDeals();
  renderSavedDeals();
}
function bestLabel(r) {
  const arr = [
    { name: 'Sell & Pay', net: r.A.net_position },
    { name: 'Full 1031', net: r.B.net_position },
    { name: 'Partial 1031', net: r.C.net_position },
    { name: 'Levered 1031', net: r.D.net_position },
  ];
  return arr.reduce((a, b) => (b.net > a.net ? b : a));
}

function renderSavedDeals() {
  const root = document.getElementById('view-saved');
  if (!root) return;
  const list = deals.length
    ? deals.map((d) => {
        const r = compute({ ...DEFAULTS, ...d.inputs });
        return `<div class="deal-row">
          <label class="deal-pick"><input type="checkbox" data-cmp="${d.id}" aria-label="Compare ${escHtml(d.name)}" ${compareSel.has(d.id) ? 'checked' : ''}/></label>
          <div class="deal-meta"><div class="deal-name">${escHtml(d.name)}</div>
            <div class="deal-sub">Sale ${money(r.inputs.sale_price)} · Equity available ${money(r.equity_available)}</div></div>
          <div class="deal-actions"><button class="mini" data-load="${d.id}">Load</button><button class="mini danger" data-del="${d.id}">Delete</button></div>
        </div>`;
      }).join('')
    : '<p class="sec-desc">No saved deals yet. Enter inputs on the Assumptions tab, then save them here to compare properties side by side.</p>';

  root.innerHTML = `
    <div class="sum-head"><h2 class="sum-title">Saved Deals &amp; Compare</h2>
      <p class="sum-sub">Save a property's inputs and compare options across deals</p>
      <p class="sum-note">Stored only in this browser — nothing is uploaded.</p></div>
    <div class="card"><div class="sec-head">SAVE CURRENT INPUTS</div>
      <div class="body"><div class="save-row">
        <input type="text" id="deal-name" placeholder="Name this deal (e.g. 1214 Park Ave)" aria-label="Deal name"/>
        <button class="btn-print" id="deal-save">Save current deal</button></div></div></div>
    <div class="card"><div class="sec-head">SAVED DEALS</div><div class="body">${list}</div></div>
    <div id="compare-box"></div>`;

  const saveBtn = document.getElementById('deal-save');
  const nameInput = document.getElementById('deal-name');
  saveBtn.addEventListener('click', () => { saveDeal(nameInput.value); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDeal(nameInput.value); });
  root.querySelectorAll('[data-load]').forEach((b) => b.addEventListener('click', () => loadDealById(+b.dataset.load)));
  root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteDealById(+b.dataset.del)));
  root.querySelectorAll('[data-cmp]').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) compareSel.add(+c.dataset.cmp); else compareSel.delete(+c.dataset.cmp);
    renderCompare();
  }));
  renderCompare();
}

function renderCompare() {
  const box = document.getElementById('compare-box');
  if (!box) return;
  const sel = deals.filter((d) => compareSel.has(d.id));
  if (!sel.length) { box.innerHTML = '<p class="footnote">Tick two or more deals above to compare them side by side.</p>'; return; }
  const rs = sel.map((d) => ({ name: d.name, r: compute({ ...DEFAULTS, ...d.inputs }) }));
  const rrow = (label, fn, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td>${rs.map((x) => `<td>${fn(x.r)}</td>`).join('')}</tr>`;
  box.innerHTML = `<div class="card"><div class="sec-head">COMPARE (${sel.length})</div>
    <div class="body" style="overflow-x:auto">
    <table class="summary"><thead><tr><th>Metric</th>${rs.map((x) => `<th>${escHtml(x.name)}</th>`).join('')}</tr></thead><tbody>
      ${rrow('Sale Price', (r) => money(r.inputs.sale_price))}
      ${rrow('Realized Gain', (r) => money(r.realized_gain))}
      ${rrow('Tax if sold now', (r) => money(r.A.total_tax))}
      <tr class="section"><td colspan="${rs.length + 1}">NET PROCEEDS / POSITION</td></tr>
      ${rrow('Sell &amp; Pay', (r) => money(r.A.net_position))}
      ${rrow('Full 1031', (r) => money(r.B.net_position))}
      ${rrow('Partial 1031', (r) => money(r.C.net_position))}
      ${rrow('Levered 1031', (r) => money(r.D.net_position))}
      ${rrow('Max Tax Deferred', (r) => money(Math.max(r.B.tax_deferred, r.C.tax_deferred, r.D.tax_deferred)))}
    </tbody></table></div></div>`;
}

/* ---------- recompute (assumptions + summary + scenarios) ---------- */
function recompute() {
  state.years_held = Math.max(0, CURRENT_YEAR - (state.year_purchased || CURRENT_YEAR));
  const r = compute(state);
  document.querySelectorAll('[data-calc]').forEach((el) => {
    const v = r[el.dataset.calc];
    if (el.dataset.fmt === 'yrs') {
      const y = Math.round(v || 0);
      el.textContent = y + (y === 1 ? ' yr' : ' yrs');
    } else {
      el.textContent = moneyZero(v);
    }
  });
  renderSummary(r);
  renderScenarios(r);
  saveState();
}

/* ---------- tabs ---------- */
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById('view-' + btn.dataset.tab).classList.add('active');
});

/* ---------- reset ---------- */
document.getElementById('reset-btn').addEventListener('click', () => {
  state = { ...DEFAULTS };
  finState = { ...FINANCING_DEFAULTS };
  renderAssumptions();
  renderFinancing();
  recompute();
});

/* ---------- boot ---------- */
renderAssumptions();
renderFinancing();
renderSavedDeals();
recompute();
})();
