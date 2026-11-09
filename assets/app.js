/* ============================================================
   TKG 1031 Calculator — UI (rendering, live recompute, formatting)
   Wrapped in an IIFE: calc.js and app.js are both classic scripts sharing
   ONE global lexical scope, so a top-level `const DEFAULTS` (etc.) in both
   collides ("already declared") and silently kills app.js on real page load.
   ============================================================ */
(function () {
const { DEFAULTS, compute, financing, FINANCING_DEFAULTS, taxAtIncome, INCOME_PROFILES,
        FILING_STATUS, applyFilingStatus, reconcileFilingStatus,
        clampedInputs } = window.Calc;
const CURRENT_YEAR = new Date().getFullYear();

/* ---------- state ---------- */
const STORAGE_KEY = 'tkg_1031_inputs_v2';   // v2: income profile, B2 scenario, bracket thresholds
const FIN_KEY = 'tkg_1031_financing';
let state = loadState(STORAGE_KEY, DEFAULTS);
let finState = loadState(FIN_KEY, FINANCING_DEFAULTS);

function loadState(key, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    // Inputs saved before the filing-status switch worked can hold a status
    // whose thresholds were never applied; reconcile rather than compute a
    // joint-return tax under a "Single" label.
    if (saved && typeof saved === 'object') {
      const merged = { ...fallback, ...saved };
      return key === STORAGE_KEY ? reconcileFilingStatus(merged) : merged;
    }
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
// on-screen currency: $#,##0 — parens for negatives, em-dash for zero/null
function money(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const r = Math.round(v);
  if (r === 0) return '—';
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
function moneyZero(v) { // like money but shows $0 instead of dash (for input echoes)
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const r = Math.round(v);
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
// print accounting format: $#,##0, parens for negatives, en-dash "–" for zero
function acct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const r = Math.round(v);
  if (r === 0) return '–';
  const s = '$' + Math.abs(r).toLocaleString('en-US');
  return r < 0 ? '(' + s + ')' : s;
}
function pct(v, dp = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return (v * 100).toFixed(dp) + '%';
}
function moneyInputStr(n) {
  const r = Math.round(n || 0);
  return r.toLocaleString('en-US');
}
function shortMoney(v) {
  if (!v) return '$0';
  const a = Math.abs(v);
  let s;
  if (a >= 1e6) s = '$' + (a / 1e6).toFixed(2) + 'M';
  else if (a >= 1e3) s = '$' + Math.round(a / 1e3) + 'K';
  else s = '$' + Math.round(a);
  return v < 0 ? '(' + s + ')' : s;
}
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- field definitions ---------- */
// type: money | pct | num | check | text | select
const SECTIONS = [
  {
    num: '', title: 'REPORT HEADER',
    desc: 'Who the report is for. These print on the client report; they do not affect the math.',
    fields: [
      ['prepared_for', 'Prepared For (client name)', 'text', 'Appears in the report header.'],
      ['property_address', 'Property Address', 'text', 'The relinquished property.'],
    ],
  },
  {
    num: '1', title: 'THE PROPERTY SALE',
    desc: 'The basics of the property you’re selling. Start here.',
    fields: [
      ['sale_price', 'Estimated Sale Price', 'money', 'What you expect to sell the relinquished property for.'],
      ['original_purchase_price', 'Original Purchase Price', 'money', 'What you originally paid for it.'],
      ['current_mortgage_payoff', 'Current Mortgage Payoff', 'money', 'Remaining loan balance paid off at closing.'],
    ],
  },
  {
    num: '2', title: 'CAPITAL IMPROVEMENTS',
    desc: 'Capitalized improvements added to basis, entered as a lump sum with the year placed in service. They depreciate on their own clock from that year.',
    fields: [
      ['capital_improvements', 'Capital Improvements (lump sum)', 'money', 'Total capitalized improvements. Not the assessed building value.'],
      ['improvement_year', 'Year Placed In Service', 'num', 'Approximate year the improvements were made.'],
    ],
    calc: [
      ['improvement_years_held', 'Improvement Years Held (calculated)', 'yrs'],
    ],
  },
  {
    num: '3', title: 'DEPRECIATION',
    desc: 'Auto straight-line, or type your own accumulated figure (a manual number overrides auto). Enter the assessor’s land/building split for a precise land %, or leave both blank for the 20% default.',
    fields: [
      ['assessed_land', 'Assessed Land Value (optional)', 'money', 'From the assessor. Used only to split land vs. building.'],
      ['assessed_building', 'Assessed Building Value (optional)', 'money', 'From the assessor. Never treated as capital improvements.'],
      ['land_pct', 'Land Value % (fallback)', 'pct', 'Used when no assessor split is entered. Land isn’t depreciable.'],
      ['recovery_life', 'Recovery Life (yrs)', 'num', '39 yr commercial, 27.5 yr residential.'],
      ['year_purchased', 'Year Purchased', 'num', 'Years held is calculated from this. Past the recovery life ⇒ fully depreciated.'],
      ['use_auto_depr', 'Use Auto Depreciation?', 'check', 'On = auto straight-line. Typing a manual number below turns this off.'],
      ['manual_depreciation', 'Manual Accumulated Depreciation', 'money', 'A manual override wins when entered.'],
    ],
    calc: [
      ['years_held', 'Years Held (calculated)', 'yrs'],
      ['land_pct_eff', 'Land % Used', 'pctlabel'],
      ['auto_depreciation', 'Auto Straight-Line Depreciation'],
      ['accumulated_depreciation', 'Accumulated Depreciation (used)'],
    ],
  },
  {
    num: '4', title: 'CLIENT INCOME PROFILE',
    desc: 'Set a reasonable income assumption without asking the client. The profile sets the “other taxable income” that stacks beneath the gain; the override lets a CPA dial it in.',
    incomeProfile: true,
    fields: [
      ['filing_status', 'Filing Status', 'select',
        'Drives the federal capital-gains breakpoints and the NIIT threshold in section 7. Changing it rewrites those three figures, so set it before any manual override.',
        Object.entries(FILING_STATUS).map(([k, v]) => [k, v.label])],
      ['other_taxable_income', 'Other Taxable Income (override)', 'money', 'The client’s other taxable income. Pick a profile above, or type a figure.'],
      ['report_income_lo', 'Printed income band, low', 'money', 'The report never states an income. It quotes this band and the tax range across it.'],
      ['report_income_hi', 'Printed income band, high', 'money', 'Most owners fall between these two figures.'],
    ],
  },
  {
    num: '5', title: 'SELLING COSTS',
    desc: 'Fees and taxes to close the sale. Defaults are typical Massachusetts figures.',
    fields: [
      ['broker_pct', 'Broker Commission %', 'pct', 'Sale commission as % of price. Typically 5–6%.'],
      ['transfer_rate', 'MA Transfer Tax ($ per $500)', 'num', 'MA deeds excise: $2.28 per $500. Applies even in a 1031.', 0.01],
      ['attorney_costs', 'Attorney Closing Costs', 'money', 'Legal fees, recording, title.'],
      ['fixed_fees', 'Fixed Fees (UCC, escrow, filing)', 'money', 'Flat closing fees, a dollar amount, not a %.'],
      ['prepay_penalty', 'Mortgage Prepayment Penalty', 'money', 'Early-payoff penalty, if any.'],
    ],
  },
  {
    num: '6', title: '1031 EXCHANGE SIZING & SCENARIOS',
    desc: 'How much equity each strategy rolls, plus the replacement economics. Rename any scenario, toggle it on/off, and set its cap rate and financing. The two full-exchange rows are the same exchange into different replacements, so set them to whatever you are proposing.',
    fields: [
      ['partial_pct', 'Partial: % of equity reinvested', 'pct', 'Reinvest this share of equity; the rest is cash boot, taxed.'],
      ['partial_replace_debt', 'Partial: replace the mortgage with new debt?', 'check', 'On = new loan replaces the debt (only the cash you pull is taxed). Off = pay off the mortgage; the debt relief is also taxed as boot.'],
      ['levered_pct', 'Levered buy-up (× net sale price)', 'pct', 'Buy a property worth this multiple of your net sale price; the rest is financed.'],
    ],
    matrix: true,
  },
  {
    num: '7', title: 'TAX RATES & THRESHOLDS (2026)',
    desc: 'Tax-law constants. Pre-filled and verified for 2026. The three figures that move with filing status — both capital-gains breakpoints and the NIIT threshold — are rewritten whenever you change the switch in section 4. A CPA can override every rate and bracket; a normal user never touches these.',
    collapsible: true, collapsed: true,
    fields: [
      ['rate_recapture', 'Depreciation Recapture rate (§1250)', 'pct', 'Unrecaptured §1250 gain, up to 25%.'],
      ['rate_ltcg_0', 'Federal LTCG — 0% bracket rate', 'pct', 'IRC §1(h).'],
      ['rate_ltcg_15', 'Federal LTCG — 15% bracket rate', 'pct', 'IRC §1(h).'],
      ['rate_ltcg', 'Federal LTCG — 20% bracket rate', 'pct', 'IRC §1(h), top bracket.'],
      ['ltcg_bkt_0', 'LTCG 0%→15% breakpoint', 'money', () => `2026 taxable-income breakpoint, ${filingLabel()}.`],
      ['ltcg_bkt_1', 'LTCG 15%→20% breakpoint', 'money', () => `2026 taxable-income breakpoint, ${filingLabel()}.`],
      ['rate_niit', 'NIIT rate', 'pct', 'Net Investment Income Tax, IRC §1411.'],
      ['niit_threshold', 'NIIT MAGI threshold', 'money', () => `Statutory, never indexed: ${money(FILING_STATUS[state.filing_status].niit_threshold)} for ${filingLabel()}. NIIT applies to the lesser of gain or MAGI over this.`],
      ['ma_rate', 'MA Income rate', 'pct', 'MA flat 5.0%.'],
      ['ma_surtax_rate', 'MA 4% Surtax rate', 'pct', 'M.G.L. c.62 §4(d).'],
      ['ma_surtax_threshold', 'MA Surtax Threshold', 'money', '2026 indexed, per return. The one threshold that does NOT move with filing status: it is not doubled on a joint return, and since 2024 a couple filing jointly federally must file jointly in MA, so they cannot split to claim two.'],
      ['ordinary_rate', 'Ordinary Income rate', 'pct', 'Top bracket; §1245 recapture.'],
    ],
  },
  {
    num: '8', title: 'ADVANCED: COST SEGREGATION',
    desc: 'Only if cost-seg was done. Leave at defaults otherwise.',
    collapsible: true, collapsed: true,
    fields: [
      ['sec1245_depreciation', '§1245 / Cost-Seg Depreciation', 'money', 'Personal-property components recaptured at ordinary rate.'],
      ['cost_seg_flag', 'Recapture §1245 at ordinary rate?', 'check', 'On = add §1245 recapture to the tax stack.'],
    ],
  },
];

/* ---------- input builders ---------- */
function toDisplay(key, type) {
  const v = state[key];
  if (type === 'pct') return +(v * 100).toFixed(4);
  return v;
}
function inputCell(key, type, value, step, dataAttr, label, opts) {
  const unit = type === 'money' ? ' (dollars)' : type === 'pct' ? ' (percent)' : '';
  const aria = label ? ` aria-label="${label.replace(/"/g, '')}${unit}"` : '';
  const pre = type === 'money' ? '<span class="pre">$</span>' : '';
  const post = type === 'pct' ? '<span class="post">%</span>' : '';
  if (type === 'text') {
    return `<div class="input-wrap"><input type="text"${aria} ${dataAttr}="${key}" data-type="text" value="${escHtml(value || '')}"/></div>`;
  }
  if (type === 'select') {
    const o = (opts || []).map(([v, l]) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
    return `<div class="input-wrap"><select${aria} ${dataAttr}="${key}" data-type="select">${o}</select></div>`;
  }
  if (type === 'money') {
    return `<div class="input-wrap">${pre}<input type="text" inputmode="numeric"${aria} ${dataAttr}="${key}" data-type="money" value="${moneyInputStr(value)}"/>${post}</div>`;
  }
  const stp = step || (type === 'pct' ? 0.1 : 1);
  return `<div class="input-wrap">${pre}<input type="number" min="0" step="${stp}"${aria} ${dataAttr}="${key}" data-type="${type}" value="${value}"/>${post}</div>`;
}

/* per-scenario matrix: editable label, show toggle, cap rate, loan rate, term, amort */
function mxCell(key, type) {
  const value = type === 'pct' ? +(state[key] * 100).toFixed(4) : state[key];
  const stp = type === 'pct' ? 0.05 : 1;
  return `<input class="mx-in" type="number" min="0" step="${stp}" data-key="${key}" data-type="${type}" value="${value}" aria-label="${key}"/>`;
}
function replacementMatrix() {
  const rows = [['B', 'Full exchange, first replacement'], ['B2', 'Full exchange, second replacement'], ['C', 'Partial'], ['D', 'Levered']];
  const body = rows.map(([k, kind]) => {
    const lk = k.toLowerCase();
    return `<tr>
      <td class="mx-chk"><input type="checkbox" data-key="${lk}_show" data-type="check" ${state[lk + '_show'] ? 'checked' : ''} aria-label="Show ${kind}"/></td>
      <td class="mx-lbl"><input class="mx-label" type="text" data-key="${lk}_label" data-type="text" value="${escHtml(state[lk + '_label'] || '')}" aria-label="${kind} label"/></td>
      <td class="mx-lbl"><input class="mx-label mx-note-in" type="text" data-key="${lk}_note" data-type="text" value="${escHtml(state[lk + '_note'] || '')}" aria-label="${kind} sub-label"/></td>
      <td>${mxCell(lk + '_yield', 'pct')}</td>
      <td>${mxCell(lk + '_rate', 'pct')}</td>
      <td>${mxCell(lk + '_term', 'num')}</td>
      <td>${mxCell(lk + '_amort', 'num')}</td>
    </tr>`;
  }).join('');
  return `<div class="mx-wrap">
    <div class="mx-title">Scenarios — label, show, and replacement economics</div>
    <table class="mx-table">
      <thead><tr><th class="mx-chk">Show</th><th>Label</th><th>Sub-label (prints)</th><th>Cap Rate %</th><th>Loan Rate %</th><th>Term (yr)</th><th>Amort (yr)</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="mx-note">The two full-exchange rows replace the full net value and defer the whole gain. The replacement can be anything that qualifies: a DST, a net leased building, multifamily, a development. Only the label, the sub-label and the cap rate change, so use them to price the same exchange against two different replacements. Cap rate drives NOI; loan rate/term/amort apply to any new debt.</p>
  </div>`;
}

/* income-profile chips */
function incomeChips() {
  const chips = [['moderate', 'Moderate', 100000], ['typical', 'Typical', 250000], ['high', 'High', 600000]];
  const cur = Math.round(state.other_taxable_income || 0);
  const html = chips.map(([k, label, val]) => {
    const active = (cur === val);
    return `<button type="button" class="ip-chip${active ? ' active' : ''}" data-profile="${k}" data-val="${val}">${label}<span class="ip-amt">${money(val)}</span></button>`;
  }).join('');
  const customActive = ![100000, 250000, 600000].includes(cur);
  return `<div class="ip-row">${html}<button type="button" class="ip-chip${customActive ? ' active' : ''}" data-profile="custom">Custom<span class="ip-amt">${customActive ? money(cur) : 'type below'}</span></button></div>`;
}

/* ---------- render: Assumptions ---------- */
function renderAssumptions() {
  const root = document.getElementById('view-assumptions');
  let html = '';
  for (const sec of SECTIONS) {
    const cls = 'card' + (sec.collapsible ? ' collapsible' : '') + (sec.collapsed ? ' collapsed' : '');
    html += `<div class="${cls}" data-sec="${sec.num}">
      <div class="sec-head" ${sec.collapsible ? `data-toggle="1" role="button" tabindex="0" aria-expanded="${sec.collapsed ? 'false' : 'true'}"` : ''}>
        <span>${sec.num ? `<span class="num">${sec.num} ·</span>` : ''}${sec.title}</span>
        ${sec.collapsible ? '<span class="chevron">▾</span>' : ''}
      </div>
      <div class="body">
        <p class="sec-desc">${sec.desc}</p>`;
    if (sec.incomeProfile) html += incomeChips();
    for (const f of sec.fields) {
      const [key, label, type, help0, opts] = f;
      // help can be a function when it has to track another input (filing status)
      const help = typeof help0 === 'function' ? help0() : help0;
      if (type === 'check') {
        html += `<div class="field"><div class="lbl">${label}<span class="help">${help}</span></div>
          <label class="switch"><input type="checkbox" aria-label="${label}" data-key="${key}" data-type="check" ${state[key] ? 'checked' : ''}/> <span>${state[key] ? 'On' : 'Off'}</span></label></div>`;
      } else {
        const value = type === 'pct' ? toDisplay(key, type) : state[key];
        const step = f[4] && type !== 'select' ? f[4] : undefined;
        html += `<div class="field"><div class="lbl">${label}<span class="help">${help}</span></div>
          ${inputCell(key, type, value, step, 'data-key', label, opts)}</div>`;
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

  html += `<div class="card calc-card"><div class="sec-head">CALCULATED: THE TAXABLE GAIN</div>
    <div class="body">
      <div class="calc-row"><div class="lbl">Total Selling Costs</div><div class="val" data-calc="transaction_costs">—</div></div>
      <div class="calc-row"><div class="lbl">Amount Realized (price − costs)</div><div class="val" data-calc="amount_realized">—</div></div>
      <div class="calc-row"><div class="lbl">Adjusted Basis</div><div class="val" data-calc="adjusted_basis">—</div></div>
      <div class="calc-row"><div class="lbl">Realized Gain</div><div class="val" data-calc="realized_gain">—</div></div>
      <div class="calc-row hero"><div class="lbl">Equity Available to Exchange</div><div class="val" data-calc="equity_available">—</div></div>
    </div></div>`;

  root.innerHTML = html;
  wireInputs(root, 'data-key', () => recompute());
  // income profile chips
  root.querySelectorAll('.ip-chip').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.profile;
    state.income_profile = p;
    if (p !== 'custom' && b.dataset.val) state.other_taxable_income = +b.dataset.val;
    renderAssumptions();
    recompute();
  }));
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

function wireInputs(root, attr, onChange) {
  const stateObj = attr === 'data-key' ? state : finState;
  root.querySelectorAll('input, select').forEach((el) => {
    const type = el.dataset.type;
    const key = el.getAttribute(attr);
    if (!key) return;
    const handler = () => {
      if (type === 'check') {
        stateObj[key] = el.checked ? 1 : 0;
        if (el.nextElementSibling) el.nextElementSibling.textContent = el.checked ? 'On' : 'Off';
      } else if (type === 'text') {
        stateObj[key] = el.value;
      } else if (type === 'select') {
        stateObj[key] = el.value;
        // Filing status is not a label: it moves both LTCG breakpoints and the
        // NIIT threshold. Rewrite them and re-render so section 7 shows the
        // figures actually in use rather than the ones we started from.
        if (key === 'filing_status' && stateObj === state) {
          Object.assign(state, applyFilingStatus(state, el.value));
          renderAssumptions();
        }
      } else {
        if (/^-?\.?$/.test(el.value)) return;
        setFromInput(stateObj, key, type, el.value);
        // typing a manual accumulated depreciation turns off auto
        if (key === 'manual_depreciation' && stateObj === state) state.use_auto_depr = 0;
        // typing an income override marks the profile custom
        if (key === 'other_taxable_income' && stateObj === state) state.income_profile = 'custom';
      }
      onChange();
    };
    el.addEventListener('input', handler);
    if (el.tagName === 'SELECT') el.addEventListener('change', handler);
    if (type === 'money') {
      el.addEventListener('focus', () => el.select());
      el.addEventListener('blur', () => {
        stateObj[key] = Math.round(stateObj[key] || 0);
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

/* ---------- charts (on-screen summary only) ---------- */
const NAVY = '#002f5f', SLATE = '#6e8aa6', ORANGE = '#9e5436', TEAL = '#2f7d6b';
function chartMoneySVG(vis) {
  const items = vis.map((s) => ({ name: s.label, net: s.net_position, debt: s.new_loan || 0, tax: s.total_tax }));
  const W = 720, H = 270, padL = 12, padR = 12, padT = 34, padB = 44;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const max = Math.max(1, ...items.flatMap((d) => [d.net, d.debt, d.tax]));
  const groupW = (W - padL - padR) / items.length;
  const barW = Math.max(14, Math.min(30, (groupW - 16) / 3)), gap = 4;
  const bar = (x, v, c) => {
    if (!(v > 0)) return '';
    const h = Math.max(0, (v / max) * plotH);
    return `<rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="2" fill="${c}"/>` +
      `<text x="${(x + barW / 2).toFixed(1)}" y="${(baseY - h - 5).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="${c}">${shortMoney(v)}</text>`;
  };
  let bars = '';
  items.forEach((d, i) => {
    const gc = padL + groupW * (i + 0.5);
    const x0 = gc - (barW * 3 + gap * 2) / 2;
    bars += bar(x0, d.net, NAVY) + bar(x0 + barW + gap, d.debt, SLATE) + bar(x0 + 2 * (barW + gap), d.tax, ORANGE);
    bars += `<text x="${gc.toFixed(1)}" y="${(baseY + 18).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${NAVY}">${escHtml(d.name)}</text>`;
  });
  const legend = `
    <rect x="12" y="6" width="11" height="11" rx="2" fill="${NAVY}"/><text x="27" y="15" font-size="11" fill="#5a6b7b">Net Proceeds / Equity Position</text>
    <rect x="252" y="6" width="11" height="11" rx="2" fill="${SLATE}"/><text x="267" y="15" font-size="11" fill="#5a6b7b">New Debt</text>
    <rect x="350" y="6" width="11" height="11" rx="2" fill="${ORANGE}"/><text x="365" y="15" font-size="11" fill="#5a6b7b">Tax Due This Year</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Net proceeds, new debt, and tax due by scenario" preserveAspectRatio="xMidYMid meet" style="font-family:Roboto,system-ui,sans-serif">
    <line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="#d7e0ea" stroke-width="1"/>
    ${legend}${bars}
  </svg>`;
}
function chartNOISVG(vis) {
  const items = vis.map((s) => ({ name: s.label, v: s.noi || 0, none: s.kind === 'sell' }));
  const W = 720, H = 200, padL = 12, padR = 12, padT = 22, padB = 40;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const max = Math.max(1, ...items.map((d) => d.v));
  const groupW = (W - padL - padR) / items.length;
  const barW = Math.max(24, Math.min(50, groupW - 24));
  let bars = '';
  items.forEach((d, i) => {
    const gc = padL + groupW * (i + 0.5);
    const x = gc - barW / 2;
    if (d.none) {
      bars += `<text x="${gc.toFixed(1)}" y="${(baseY - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6b7884">no rental income</text>`;
    } else {
      const h = Math.max(0, (d.v / max) * plotH);
      bars += `<rect x="${x.toFixed(1)}" y="${(baseY - h).toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="3" fill="${TEAL}"/>` +
        `<text x="${gc.toFixed(1)}" y="${(baseY - h - 6).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${TEAL}">${shortMoney(d.v)}</text>`;
    }
    bars += `<text x="${gc.toFixed(1)}" y="${(baseY + 16).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${NAVY}">${escHtml(d.name)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Annual NOI by scenario" preserveAspectRatio="xMidYMid meet" style="font-family:Roboto,system-ui,sans-serif">
    <line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="#d7e0ea" stroke-width="1"/>${bars}
  </svg>`;
}

/* ---------- render: Summary (on-screen; keeps the current look) ---------- */
function renderSummary(r) {
  const root = document.getElementById('view-summary');
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const vis = r.visible;
  const names = vis.map((s) => escHtml(s.label));
  const span = vis.length + 1;

  const row = (label, vals, opts = {}) => {
    if (opts.section) return `<tr class="section"><td colspan="${span}">${label}</td></tr>`;
    const classes = [];
    if (opts.strong) classes.push('strong');
    if (opts.subtle) classes.push('subtle');
    if (opts.bottom) classes.push('bottom');
    if (opts.hi) classes.push('hi');
    return `<tr class="${classes.join(' ')}"><td>${label}</td>${vals.map((v) => `<td>${v}</td>`).join('')}</tr>`;
  };
  const col = (fn) => vis.map(fn);

  let html = `
  <div class="sum-head">
    <button class="btn-print no-print" id="print-btn-sum" title="Print or save the branded client report as PDF">⎙ Print Report</button>
    <h2 class="sum-title">Client Summary</h2>
    <p class="sum-sub">1031 Exchange &amp; Financing Analysis${r.inputs.property_address ? ' · ' + escHtml(r.inputs.property_address) : ''}</p>
    <p class="sum-note">Estimates only. Confirm with your CPA &amp; attorney. Assumes ${money(r.other_taxable_income)} other taxable income (${escHtml(profileLabel())}), ${filingLabel()}.</p>
  </div>

  <div class="bridge">
    <div class="bridge-item"><span class="bl">Sale Price</span><span class="bv">${money(r.inputs.sale_price)}</span></div>
    <div class="bridge-op">−</div>
    <div class="bridge-item"><span class="bl">Selling Costs</span><span class="bv">${money(r.transaction_costs)}</span></div>
    <div class="bridge-op">=</div>
    <div class="bridge-item total"><span class="bl">Value to Replace (net sale price)</span><span class="bv">${money(r.amount_realized)}</span></div>
  </div>
  <p class="bridge-note">To fully defer, reinvest all <strong>${money(r.equity_available)}</strong> of equity and replace the <strong>${money(r.inputs.current_mortgage_payoff)}</strong> mortgage with new debt. Any shortfall is taxed as “boot.”</p>

  <div class="table-scroll"><table class="summary">
    <thead><tr><th>Scenario</th>${names.map((n) => `<th>${n}</th>`).join('')}</tr></thead>
    <tbody>
      ${row('THE EXCHANGE MATH', null, { section: true })}
      ${row('Reinvestment / Buy-Up %', col((s) => s.kind === 'sell' ? '—' : pct(s.reinvest_pct)))}
      ${row('New Property Value', col((s) => s.kind === 'sell' ? '—' : money(s.replacement_value)), { strong: true })}
      ${row('Equity Put Into Property', col((s) => s.kind === 'sell' ? '—' : money(s.equity_contributed)))}
      ${row('New Loan', col((s) => s.kind === 'sell' ? '—' : money(s.new_loan)))}
      ${row('Cash Boot Taken', col((s) => s.kind === 'partial' ? money(s.cash_boot) : '—'))}

      ${row('THE TAX', null, { section: true })}
      ${row('Realized Gain', col(() => money(r.realized_gain)))}
      ${row('Gain Recognized (taxed now)', col((s) => s.recognized_gain > 0 ? money(s.recognized_gain) : '—'))}
      ${row('Total Tax Due This Year', col((s) => s.recognized_gain > 0 ? money(s.total_tax) : '—'), { strong: true, subtle: true })}
      ${row('Tax Deferred vs. Selling', col((s) => s.kind === 'sell' ? '—' : money(s.tax_deferred)))}

      ${row('THE NEW INCOME', null, { section: true })}
      ${row('Cap Rate', col((s) => s.kind === 'sell' ? '—' : pct(s.yield)))}
      ${row('Annual NOI (new property)', col((s) => s.kind === 'sell' ? '—' : money(s.noi)))}
      ${row('Net Cash Flow After Debt', col((s) => s.kind === 'sell' ? '—' : money(s.net_cash_flow)), { hi: true })}

      ${row('Net Proceeds / Position', col((s) => money(s.net_position)), { bottom: true })}
    </tbody>
  </table></div>

  <div id="warn-box" class="warnings"></div>

  <div class="card chart-card"><div class="sec-head">AT A GLANCE</div>
    <div class="body chart-body">
      <div class="chart-title">Position, debt &amp; tax</div>
      ${chartMoneySVG(vis)}
      <div class="chart-title" style="margin-top:16px">Annual property income (NOI)</div>
      ${chartNOISVG(vis)}
    </div>
  </div>

  <p class="footnote">Tax stack: 25% §1250 recapture, federal LTCG across ${pct(r.inputs.rate_ltcg_0,0)}/${pct(r.inputs.rate_ltcg_15,0)}/${pct(r.inputs.rate_ltcg,0)} brackets, ${pct(r.inputs.rate_niit)} NIIT (capped), MA ${pct(r.inputs.ma_rate,0)} + ${pct(r.inputs.ma_surtax_rate,0)} surtax on income over ${money(r.inputs.ma_surtax_threshold)}. §1031 needs 45-day ID / 180-day close.</p>

  <div class="disclaimer"><strong>Disclaimer.</strong> Estimates only. Confirm with your accountant and attorney. §1031 deferral requires replacing value, equity, AND debt, plus the 45-day identification / 180-day closing deadlines; this model assumes a qualifying exchange. The §1.168(i)-6 election (Levered) and §1245 cost-seg recapture require CPA sign-off. The analysis assumes ${money(r.other_taxable_income)} of other taxable income.</div>
  `;
  root.innerHTML = html;

  const warns = buildWarnings(r);
  document.getElementById('warn-box').innerHTML =
    buildDataChecks(r).map((t) => `<div class="warn check">Check: ${t}</div>`).join('')
    + warns.map((w) => `<div class="warn">⚠︎ ${w.text}</div>`).join('');
  const pb = document.getElementById('print-btn-sum');
  if (pb) pb.addEventListener('click', () => {
    // Not a blocker - one look at anything suspicious before it leaves the room.
    const checks = buildDataChecks(r);
    if (checks.length && !window.confirm(
      'Before printing, check these inputs:\n\n  • ' + checks.join('\n  • ') + '\n\nPrint anyway?')) return;
    fitPrintPages();
    window.print();
  });
}

function profileLabel() {
  const p = state.income_profile;
  return p === 'moderate' ? 'Moderate' : p === 'high' ? 'High' : p === 'custom' ? 'Custom' : 'Typical';
}
function filingLabel() {
  const f = FILING_STATUS[state.filing_status];
  return f ? f.label.toLowerCase() : FILING_STATUS.mfj.label.toLowerCase();
}

/* Fields that belong to ONE property. Everything else - selling-cost rates,
   cap rates, loan terms, filing status, the income band - is a standing
   assumption that should survive from deal to deal. "New deal" clears this
   list and keeps the rest; Reset restores the 1214 Park sample in full. */
const DEAL_FIELDS = {
  prepared_for: '', property_address: '',
  sale_price: 0, original_purchase_price: 0, current_mortgage_payoff: 0,
  capital_improvements: 0, improvement_year: CURRENT_YEAR, year_purchased: CURRENT_YEAR,
  assessed_land: 0, assessed_building: 0,
  manual_depreciation: 0, use_auto_depr: 1,
  sec1245_depreciation: 0, cost_seg_flag: 0,
};

/* Data-hygiene checks. These are NOT economic warnings and they never print -
   they catch the input mistakes that would otherwise reach an owner's CPA
   looking deliberate. The one that prompted this: a manual accumulated-
   depreciation figure typed for one building silently carries into the next
   deal (it also switches auto off permanently), and on a real pair of deals
   that overstated the tax by $160,272 with nothing on the report to show it. */
function buildDataChecks(r) {
  const i = r.inputs, out = [];
  if (!String(i.prepared_for || '').trim()) out.push('No "Prepared for" name - the report will print a dash.');
  if (!String(i.property_address || '').trim()) out.push('No property address.');
  if (!(i.original_purchase_price > 0)) out.push('Original purchase price is $0, so the basis is improvements only and the gain is overstated.');
  if (i.year_purchased >= CURRENT_YEAR) out.push(`Year purchased is ${i.year_purchased} - years held is ${r.years_held}.`);
  if (i.use_auto_depr === 0) {
    out.push(`Accumulated depreciation is a MANUAL ${money(i.manual_depreciation)}, typed rather than calculated. `
      + `Auto would give ${money(r.auto_depreciation)}. Check it belongs to this building.`);
  }
  if (i.cost_seg_flag === 1 && !(i.sec1245_depreciation > 0)) out.push('Cost-seg recapture is on but the §1245 figure is $0.');
  if (i.capital_improvements > 0 && i.improvement_year < i.year_purchased) {
    out.push(`Improvements are dated ${i.improvement_year}, before the ${i.year_purchased} purchase.`);
  }
  if (r.realized_gain <= 0) {
    out.push(`This deal is a LOSS of ${money(-r.realized_gain)} - the sale price is below the adjusted basis. `
      + 'There is no gain to defer, so the exchange columns are not a comparison.');
  }
  const clamped = clampedInputs(r.raw_inputs || i);
  if (clamped.length) out.push('Out of range, so the engine used a minimum of 1 year: ' + clamped.join('; ') + '.');
  return out;
}

function buildWarnings(r) {
  const warns = [];
  if (r.equity_available < 0)
    warns.push({ id: 'no-equity', text: 'Mortgage payoff exceeds net sale proceeds; there is no equity available to exchange, so the 1031 scenarios show $0.' });
  if (r.C.show && r.C.mortgage_boot > 0)
    warns.push({ id: 'mortgage-boot', text: `Partial does not replace the ${money(r.inputs.current_mortgage_payoff)} mortgage, so that debt relief is also taxed as boot. The Partial taxable gain (${money(r.C.recognized_gain)}) exceeds the cash taken out (${money(r.C.cash_boot)}).` });
  else if (r.C.show && r.C.cash_boot > 0)
    warns.push({ id: 'cash-boot', text: 'The Partial exchange takes cash out; that cash is taxable this year as boot (recapture layer first).' });
  if (r.C.show && r.C.boot_cash_kept < 0)
    warns.push({ id: 'tax-exceeds-cash', text: 'In the Partial scenario the tax exceeds the cash taken out, so the shortfall must be paid from other funds.' });
  return warns;
}


/* ---------- PRINT REPORT (two Excel-style sheets, @media print) ----------
   The prose below is fixed boilerplate that never changes between deals, and
   every variable sits in its own cell, so the report generates straight from
   the inputs with no copy rewriting. */
const DASH = '–';
const PR = {
  how1031: [
    'You sell, but the proceeds never reach you. A qualified intermediary holds them and applies them to the replacement property, so the gain is not recognized in the year of the sale.',
    'Replace the value, the equity and the debt in full and the entire gain is deferred. Reinvest less than that and only the shortfall is taxed, not the whole gain.',
    'The tax is deferred rather than erased. It carries into the basis of the new property and comes due if that property is later sold without another exchange.',
  ],
  replacement: [
    'A full exchange defers the whole gain whatever you buy, so long as the value, the equity and the debt are replaced. The replacement decides the return and the workload, not the tax.',
    'A Delaware Statutory Trust sits at one end: a fractional interest in a large, professionally managed property. It qualifies as like-kind and carries no management role, but yields run lower and the interest is illiquid, commonly five to ten years.',
    'At the other end are assets you control, from a net leased building to multifamily or a development. Higher yields, more work, more risk.',
  ],
  day0: 'You close the sale. A qualified intermediary receives the proceeds, not you.',
  day45: 'Identify the replacement property in writing. You may name up to three, and buy any or all of them.',
  day180: 'Close on what you identified. Both deadlines run from the sale closing and there are no extensions.',
  partialNote: 'The Partial column reinvests part of the equity and takes the rest as cash. That cash is taxed this year as boot. The share reinvested is an input and can be set to any level.',
  inputsNote: 'Figures in blue are inputs. Tell us if any are wrong and every number in this analysis moves with them.',
  disclaimer: 'Estimates only, not tax or legal advice. Confirm with your CPA and attorney.',
};

/* The identification strip shares the comparison grid's columns, so its
   divisions land on the grid's lines instead of cutting across them.

   The grid is one 25% row-label column plus ONE COLUMN PER VISIBLE SCENARIO,
   so that split changes every time a scenario is toggled off: five scenarios
   divide at 25/40/55/70/85, four at 25/43.75/62.5/81.25, three at 25/50/75.
   Pinning the strip to the five-column case (the first version of this fix)
   was right for the default deal and wrong for every other one.

   Three label/value pairs have to fit into (scenarios + 1) columns. Where a
   pair can have two columns it keeps a grey label cell and a value cell; where
   it can only have one, it collapses into a single cell with the label inline.
   Extra columns go to the leftmost pair, because addresses are the long value.
   Below three columns there is nothing meaningful to align to, so it falls
   back to an even split. */
function prIdStrip(I, dateStr, nCols) {
  const pairs = [
    ['Property', escHtml(I.property_address || DASH)],
    ['Prepared for', escHtml(I.prepared_for || DASH)],
    ['Date', dateStr],
  ];
  if (nCols < 3) {
    // One scenario: two grid columns cannot carry six cells, and any split we
    // chose would be a line that matches nothing. Run the pairs inline in a
    // single cell instead, so the strip has no internal divisions to misalign.
    return `<table class="pr-id"><tbody><tr><td class="pr-id-merged" colspan="${nCols}">${pairs
      .map(([k, v]) => `<span class="pr-id-k">${k}</span>${v}`).join('<span class="pr-id-gap"></span>')}`
      + `</td></tr></tbody></table>`;
  }
  const base = Math.floor(nCols / 3), rem = nCols % 3;
  const span = [0, 1, 2].map((n) => base + (n < rem ? 1 : 0));
  const colgroup = `<colgroup><col class="pr-c0"/>${'<col/>'.repeat(nCols - 1)}</colgroup>`;
  const cells = pairs.map(([k, v], n) => (span[n] >= 2
    ? `<th scope="row">${k}</th><td>${v}</td>`
    : `<td class="pr-id-merged"><span class="pr-id-k">${k}</span>${v}</td>`)).join('');
  return `<table class="pr-id">${colgroup}<tbody><tr>${cells}</tr></tbody></table>`;
}

function prLetterhead(doctype) {
  return `<div class="pr-head">
      <div class="pr-brand">
        <img class="pr-logo" src="assets/mm-logo-blue.png" alt="Marcus &amp; Millichap"/>
        <span class="pr-vrule"></span>
        <span class="pr-team">THE KLEIN GROUP</span>
      </div>
      <div class="pr-doctype">${doctype}</div>
    </div>`;
}
function prFooter(n, total) {
  return `<div class="pr-foot"><span>Marcus &amp; Millichap &nbsp;|&nbsp; The Klein Group</span>` +
    `<span>${PR.disclaimer}</span><span>Sheet ${n} of ${total}</span></div>`;
}

function renderPrintReport(r) {
  const root = document.getElementById('print-report');
  if (!root) return;
  const I = r.inputs;
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Report order: sell, partial, the full exchanges, then levered.
  const ord = ['A', 'C', 'B', 'B2', 'D'].map((k) => r[k]).filter((s) => s && s.show);
  if (!ord.length) { root.innerHTML = ''; return; }
  const nCol = ord.length + 1;

  // Tax range across the assumed income band: no stated income, no filing status.
  const incLo = I.report_income_lo, incHi = I.report_income_hi;
  const loTax = taxAtIncome(I, incLo).tax_if_sold;
  const hiTax = taxAtIncome(I, incHi).tax_if_sold;

  /* ---- sheet 1: the comparison ---- */
  let z = 0;
  const band = (t) => { z = 0; return `<tr class="pr-band"><td colspan="${nCol}">${t}</td></tr>`; };
  const row = (label, fn, cls) => {
    const stripe = (z++ % 2 === 1) ? ' pr-zebra' : '';
    const cells = ord.map((s) => {
      const v = fn(s);
      return `<td${v === DASH ? ' class="pr-dash"' : ''}>${v}</td>`;
    }).join('');
    return `<tr class="${(cls || '') + stripe}"><th scope="row">${label}</th>${cells}</tr>`;
  };

  // Band spanning a contiguous run of full exchanges (DST vs NNN).
  let groupRow = '';
  const fullIx = [];
  ord.forEach((s, i) => { if (s.kind === 'full') fullIx.push(i); });
  if (fullIx.length > 1 && fullIx[fullIx.length - 1] - fullIx[0] + 1 === fullIx.length) {
    const a = fullIx[0], b = fullIx[fullIx.length - 1];
    let cells = '<td class="pr-blank"></td>';
    let i = 0;
    while (i < ord.length) {
      if (i === a) { cells += `<td class="pr-group" colspan="${fullIx.length}">FULL EXCHANGE</td>`; i = b + 1; }
      else { cells += '<td class="pr-blank"></td>'; i++; }
    }
    groupRow = `<tr>${cells}</tr>`;
  }

  const headRow = `<tr><th scope="col">Scenario</th>${ord.map((s) =>
    `<th scope="col">${escHtml(s.label)}${s.note ? `<span class="pr-sublbl">${escHtml(s.note)}</span>` : ''}</th>`).join('')}</tr>`;

  const grid = `<table class="pr-grid">
      <colgroup><col class="pr-c0"/>${ord.map(() => '<col/>').join('')}</colgroup>
      <thead>${groupRow}${headRow}</thead>
      <tbody>
        ${band('THE SALE')}
        ${row('Sale price', () => acct(I.sale_price))}
        ${row('Less selling costs', () => acct(-r.transaction_costs))}
        ${row('Net sale price', () => acct(r.amount_realized), 'pr-sub')}
        ${band('THE GAIN AND THE TAX')}
        ${row('Taxable gain recognized this year', (s) => s.recognized_gain > 0 ? acct(s.recognized_gain) : DASH)}
        ${row('Tax deferred versus selling', (s) => s.kind === 'sell' ? DASH : acct(s.tax_deferred))}
        ${band('THE REPLACEMENT PROPERTY')}
        ${row('Replacement property value', (s) => s.kind === 'sell' ? DASH : acct(s.replacement_value))}
        ${row('Equity reinvested', (s) => s.kind === 'sell' ? DASH : acct(s.equity_contributed))}
        ${row('New loan', (s) => s.kind === 'sell' ? DASH : acct(s.new_loan))}
        ${row('Cash taken out, taxed as boot', (s) => (s.kind === 'partial' && s.cash_boot > 0) ? acct(s.cash_boot) : DASH)}
        ${band('ANNUAL CASH FLOW')}
        ${row('Cap rate on the replacement', (s) => s.kind === 'sell' ? DASH : pct(s.yield, 2))}
        ${row('Net operating income', (s) => s.kind === 'sell' ? DASH : acct(s.noi))}
        ${row('Less loan payments', (s) => s.kind === 'sell' ? DASH : acct(s.annual_debt_service))}
        ${row('Cash flow to you, each year', (s) => s.kind === 'sell' ? DASH : acct(s.net_cash_flow), 'pr-cf')}
        ${band('WHERE YOU LAND')}
        ${row('Total tax paid', (s) => s.total_tax > 0 ? acct(s.total_tax) : DASH, 'pr-taxrow')}
        ${row('What you keep or reinvest', (s) => acct(s.net_position), 'pr-total')}
      </tbody>
    </table>`;

  const notes = [
    `Figures assume other taxable income between ${acct(incLo)} and ${acct(incHi)}, where most owners fall. There is some variation across that range: the total tax on a sale runs from ${acct(loTax)} to ${acct(hiTax)}. Sheet 2 sets out the calculation.`,
  ];
  const hasPartial = ord.some((s) => s.kind === 'partial');
  if (hasPartial) notes.push(PR.partialNote);
  // the static partial note already covers plain cash boot, so don't say it twice
  buildWarnings(r).forEach((w) => {
    if (hasPartial && w.id === 'cash-boot') return;
    notes.push(w.text);
  });

  const sheet1 = `<section class="pr-page"><div class="pr-fit">
      ${prLetterhead('1031 Exchange &amp; Financing Analysis')}
      ${prIdStrip(I, dateStr, ord.length + 1)}
      ${grid}
      <ol class="pr-notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ol>
      ${prFooter(1, 2)}
    </div></section>`;

  /* ---- sheet 2: how it works ---- */
  const taxed = ord.filter((s) => s.recognized_gain > 0);
  const part = (s, i) => ((s.tax_breakdown.ltcg_parts || [])[i] || { amount: 0, tax: 0 });
  const show0 = taxed.some((s) => part(s, 0).amount > 0);
  let tz = 0;
  const taxRow = (label, fn, cls) => {
    const stripe = (tz++ % 2 === 1) ? ' pr-zebra' : '';
    return `<tr class="${(cls || '') + stripe}"><th scope="row">${label}</th>${taxed.map((s) => {
      const v = fn(s);
      return `<td${v === DASH ? ' class="pr-dash"' : ''}>${v}</td>`;
    }).join('')}</tr>`;
  };
  const taxBox = taxed.length ? `<table class="pr-tax">
      <thead><tr><th scope="col">Component</th>${taxed.map((s) => `<th scope="col">${escHtml(s.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${taxRow(`Depreciation recapture, ${pct(I.rate_recapture, 0)}`, (s) => acct(s.tax_breakdown.tax_recapture))}
        ${show0 ? taxRow(`Federal capital gains, ${pct(I.rate_ltcg_0, 0)} band`, (s) => acct(part(s, 0).tax)) : ''}
        ${taxRow(`Federal capital gains, ${pct(I.rate_ltcg_15, 0)} band`, (s) => acct(part(s, 1).tax))}
        ${taxRow(`Federal capital gains, ${pct(I.rate_ltcg, 0)} band`, (s) => acct(part(s, 2).tax))}
        ${taxRow(`Net investment income tax, ${pct(I.rate_niit)}`, (s) => acct(s.tax_breakdown.tax_niit))}
        ${taxRow(`Massachusetts income tax, ${pct(I.ma_rate, 0)}`, (s) => acct(s.tax_breakdown.tax_ma))}
        ${taxRow(`Massachusetts surtax, ${pct(I.ma_surtax_rate, 0)}`, (s) => acct(s.tax_breakdown.tax_surtax))}
        ${I.cost_seg_flag === 1 ? taxRow('Cost segregation recapture', (s) => acct(s.tax_breakdown.tax_1245)) : ''}
        <tr class="pr-taxtotal"><th scope="row">Total tax paid</th>${taxed.map((s) => `<td>${acct(s.total_tax)}</td>`).join('')}</tr>
        <tr class="pr-range"><th scope="row">Range across the income band</th><td colspan="${taxed.length}">${acct(loTax)} to ${acct(hiTax)}</td></tr>
      </tbody>
    </table>`
    : `<div class="pr-boxbody"><p>No gain is recognized in any selected scenario, so no tax is due this year.</p></div>`;

  // Assumptions: blue marks a true input, black a computed figure.
  const aRow = (label, val, isIn) => `<tr><th scope="row">${label}</th><td${isIn ? ' class="pr-in"' : ''}>${val}</td></tr>`;
  // A group heading, so each cap-rate row carries only the scenario name.
  // "Cap rate, 1031 into Absolute NNN" is far too long for this column and wrapped
  // every row to two lines; the name alone fits.
  const aGroup = (label) => `<tr class="pr-asmgrp"><th scope="row" colspan="2">${label}</th></tr>`;
  const exch = ord.filter((s) => s.kind !== 'sell');
  const uniqRate = exch.filter((s, i, a) => a.findIndex((x) => x.rate === s.rate) === i);
  const uniqAmort = exch.filter((s, i, a) => a.findIndex((x) => x.amort === s.amort) === i);
  const loanRate = (uniqRate.length === 1 && uniqAmort.length === 1)
    ? `${pct(exch[0].rate, 2)}, ${exch[0].amort} yr amort`
    : 'varies by scenario';

  const asmA = [
    aRow('Sale price', acct(I.sale_price), 1),
    aRow('Original purchase', acct(I.original_purchase_price), 1),
    aRow('Capital improvements', I.capital_improvements > 0 ? acct(I.capital_improvements) : 'none', 1),
    aRow('Year purchased', I.year_purchased, 1),
    aRow('Years held', r.years_held, 0),
    aRow('Land share', pct(r.land_pct, 1) + (r.land_source === 'per assessor' ? ', per assessor' : ''), r.land_source === 'per assessor' ? 0 : 1),
    aRow('Recovery life', I.recovery_life + ' yrs', 1),
    aRow('Depreciation taken', acct(r.accumulated_depreciation), 0),
    aRow('Selling costs', acct(r.transaction_costs), 0),
    aRow('Mortgage payoff', acct(I.current_mortgage_payoff), 1),
  ].join('');

  const asmB = [
    ord.some((s) => s.kind === 'partial') ? aRow('Partial: share reinvested', pct(I.partial_pct, 0), 1) : '',
    ord.some((s) => s.kind === 'levered') ? aRow('Levered: buy-up multiple', I.levered_pct.toFixed(2) + '×', 1) : '',
  ].concat(exch.length ? [aGroup('Cap rate on the replacement')] : [])
   .concat(exch.map((s) => aRow(escHtml(s.label), pct(s.yield, 2), 1)))
   .concat([aRow('Loan rate', loanRate, 1)])
   .filter(Boolean).join('');

  /* The two assumptions about the CLIENT rather than the property. Both carry
     long values — a dollar range and "Married filing separately" — so they get
     a full-width strip of their own. Squeezed into the narrow right-hand column
     they wrapped, and a dollar range broken across two lines ("$100,000 to" /
     "$600,000") is not something to put in front of an owner.
     Filing status is an input the client can correct, which is what this block
     is for. It never appears on sheet 1. */
  const asmWide = `<table class="pr-asmwide"><tbody><tr>
      <th scope="row">Income band</th><td class="pr-in">${acct(incLo)} to ${acct(incHi)}</td>
      <th scope="row">Filing status</th><td class="pr-in">${(FILING_STATUS[I.filing_status] || FILING_STATUS.mfj).label}</td>
    </tr></tbody></table>`;

  const sheet2 = `<section class="pr-page"><div class="pr-fit">
      ${prLetterhead('How the exchange works')}
      <div class="pr-box">
        <div class="pr-boxhead">THE EXCHANGE TIMELINE</div>
        <div class="pr-tl">
          <div class="pr-tlcell"><div class="pr-tlday">DAY 0</div><div class="pr-tltext">${PR.day0}</div></div>
          <div class="pr-tlcell"><div class="pr-tlday">DAY 45</div><div class="pr-tltext">${PR.day45}</div>
            <div class="pr-tlboxes"><span class="pr-tlbox">1</span><span class="pr-tlbox">2</span><span class="pr-tlbox">3</span></div></div>
          <div class="pr-tlcell"><div class="pr-tlday">DAY 180</div><div class="pr-tltext">${PR.day180}</div></div>
        </div>
      </div>
      <div class="pr-2col">
        <section class="pr-box"><h2 class="pr-boxhead">HOW A 1031 EXCHANGE WORKS</h2>
          <div class="pr-boxbody">${PR.how1031.map((p) => `<p>${p}</p>`).join('')}</div></section>
        <section class="pr-box"><h2 class="pr-boxhead">CHOOSING THE REPLACEMENT PROPERTY</h2>
          <div class="pr-boxbody">${PR.replacement.map((p) => `<p>${p}</p>`).join('')}</div></section>
      </div>
      <div class="pr-2col">
        <section class="pr-box"><h2 class="pr-boxhead">HOW THE TAX IS CALCULATED</h2>${taxBox}</section>
        <section class="pr-box"><h2 class="pr-boxhead">ASSUMPTIONS AND INPUTS</h2>
          <div class="pr-asmwrap">
            <table class="pr-asm pr-asmcol1"><tbody>${asmA}</tbody></table>
            <table class="pr-asm"><tbody>${asmB}</tbody></table>
          </div>
          ${asmWide}
          <div class="pr-asmnote">${PR.inputsNote}</div>
        </section>
      </div>
      ${prFooter(2, 2)}
    </div></section>`;

  root.innerHTML = sheet1 + sheet2;
  fitPrintPages();
}

/* Fit-to-page, the way Excel does it. Each sheet is one physical page, so no
   sheet may ever spill. Footnote count, a long address, an extra scenario —
   anything can push a sheet over, and a tuned padding only holds for the deal
   it was tuned on. So measure what the sheet actually needs and scale it down
   to fit. The report is laid out off-screen at the true print width (10.2in at
   0.4in margins), so these screen measurements are the print measurements. */
const PR_PAGE_PX = 7.62 * 96;   // printable height, px at 96dpi
const PR_MIN_FIT = 0.78;        // below this, shrinking it further is worse than telling us
function fitPrintPages() {
  document.querySelectorAll('#print-report .pr-fit').forEach((el) => {
    el.style.zoom = '';
    el.style.height = 'auto';
    const need = el.scrollHeight;
    const k = Math.max(PR_MIN_FIT, Math.min(1, PR_PAGE_PX / need));
    // zoom, not transform: zoom shrinks the layout box too, so the sheet really
    // occupies one page. A transform only repaints it smaller and the page still
    // breaks on the original height. Lengths inside a zoomed box are in zoomed
    // units, so the height is divided by k while width:100% needs no correction.
    el.style.height = (PR_PAGE_PX / k) + 'px';
    if (k < 1) el.style.zoom = k;
    el.dataset.fit = k.toFixed(3);
    el.dataset.need = need;
  });
}

/* ---------- Financing Tool ---------- */
const FIN_FIELDS = [
  ['noi', 'Net Operating Income (NOI)', 'money'],
  ['sale_price', 'Property / Sale Price', 'money'],
  ['loan', 'Loan Amount', 'money'],
  ['term_years', 'Loan Term (yrs), balloon', 'num'],
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
      <div class="body"><p class="sec-desc">Standalone debt sizing, independent of the exchange logic. The same NOI, price, loan, and rate feed both the conventional (amortizing) and interest-only views.</p>${inputsHtml}</div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="sec-head">CONVENTIONAL (AMORTIZING)</div><div id="fin-conv" class="fin-out"></div></div>
      <div class="card"><div class="sec-head">INTEREST-ONLY</div><div id="fin-io" class="fin-out"></div></div>
    </div>
    <p class="footnote">Payment uses the monthly convention: PMT(rate/12, amort×12, loan) × 12. Term is the balloon/maturity and does not drive the payment.</p>`;
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

/* ---------- Saved deals ---------- */
const DEALS_KEY = 'tkg_1031_deals_v2';
let deals = loadDeals();
const compareSel = new Set();
/* Every path that turns a saved deal back into inputs goes through here — the
   list, the compare table and loading one. A deal saved while the filing-status
   dropdown was inert can hold a status its thresholds never matched, and all
   three paths would otherwise show joint-return tax under a "Single" label. */
function dealInputs(d) {
  return reconcileFilingStatus({ ...DEFAULTS, ...d.inputs });
}
function loadDeals() {
  try { const d = JSON.parse(localStorage.getItem(DEALS_KEY)); return Array.isArray(d) ? d : []; }
  catch (e) { return []; }
}
function persistDeals() { try { localStorage.setItem(DEALS_KEY, JSON.stringify(deals)); } catch (e) {} }
function nextDealId() { return deals.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1; }
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
  state = dealInputs(d);
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
function renderSavedDeals() {
  const root = document.getElementById('view-saved');
  if (!root) return;
  const list = deals.length
    ? deals.map((d) => {
        const r = compute(dealInputs(d));
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
      <p class="sum-note">Stored only in this browser; nothing is uploaded.</p></div>
    <div class="card"><div class="sec-head">SAVE CURRENT INPUTS</div>
      <div class="body"><div class="save-row">
        <input type="text" id="deal-name" placeholder="Name this deal (e.g. 1214 Park Ave)" aria-label="Deal name"/>
        <button class="btn-print" id="deal-save">Save current deal</button></div></div></div>
    <div class="card"><div class="sec-head">SAVED DEALS</div><div class="body">${list}</div></div>
    <div id="compare-box"></div>`;
  document.getElementById('deal-save').addEventListener('click', () => saveDeal(document.getElementById('deal-name').value));
  document.getElementById('deal-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDeal(e.target.value); });
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
  const rs = sel.map((d) => ({ name: d.name, r: compute(dealInputs(d)) }));
  const rrow = (label, fn) => `<tr><td>${label}</td>${rs.map((x) => `<td>${fn(x.r)}</td>`).join('')}</tr>`;
  box.innerHTML = `<div class="card"><div class="sec-head">COMPARE (${sel.length})</div>
    <div class="body" style="overflow-x:auto">
    <table class="summary"><thead><tr><th>Metric</th>${rs.map((x) => `<th>${escHtml(x.name)}</th>`).join('')}</tr></thead><tbody>
      ${rrow('Sale Price', (r) => money(r.inputs.sale_price))}
      ${rrow('Realized Gain', (r) => money(r.realized_gain))}
      ${rrow('Tax if sold now', (r) => money(r.A.total_tax))}
      <tr class="section"><td colspan="${rs.length + 1}">NET PROCEEDS / POSITION</td></tr>
      ${rrow('Sell &amp; Pay', (r) => money(r.A.net_position))}
      ${rrow('Max Tax Deferred', (r) => money(Math.max(r.B.tax_deferred, r.C.tax_deferred, r.D.tax_deferred)))}
    </tbody></table></div></div>`;
}

/* ---------- recompute ---------- */
function recompute() {
  state.years_held = Math.max(0, CURRENT_YEAR - (state.year_purchased || CURRENT_YEAR));
  state.improvement_years_held = Math.max(0, CURRENT_YEAR - (state.improvement_year || CURRENT_YEAR));
  const r = compute(state);
  document.querySelectorAll('[data-calc]').forEach((el) => {
    const key = el.dataset.calc;
    const fmt = el.dataset.fmt;
    if (fmt === 'yrs') {
      const y = Math.round(r[key] || 0);
      el.textContent = y + (y === 1 ? ' yr' : ' yrs');
    } else if (fmt === 'pctlabel' && key === 'land_pct_eff') {
      el.textContent = pct(r.land_pct) + ' (' + r.land_source + ')';
    } else {
      el.textContent = moneyZero(r[key]);
    }
  });
  renderSummary(r);
  renderPrintReport(r);
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
document.getElementById('newdeal-btn').addEventListener('click', () => {
  if (!window.confirm('Clear the property and start a new deal?\n\nSelling-cost rates, cap rates, loan terms, filing status and the income band are kept.')) return;
  Object.assign(state, DEAL_FIELDS);
  renderAssumptions();
  recompute();
  document.querySelector('#tabs button[data-tab="assumptions"]').click();
});

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

// Cmd+P skips the Print Report button, so fit on the browser's own print event
// too. Re-fit once the webfonts land, since they change the measured height.
window.addEventListener('beforeprint', fitPrintPages);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitPrintPages);
})();
