/*
 * lp-core.js
 * 線性規劃核心模組：模型描述 → 數學式顯示 → CPLEX LP 文字 → 呼叫 HiGHS 求解 → 結果分析
 * 可同時在瀏覽器（window.LPCore）與 Node.js（require）使用，方便測試。
 *
 * 模型物件 (model)：
 * {
 *   sense : 'max' | 'min',
 *   names : ['x1','x2',...]      // 傳給求解器的變數名稱（需為合法 LP 名稱）
 *   disp  : ['x1','x2',...]      // 畫面顯示用名稱
 *   labels: ['產品A','產品B']      // （選用）決策變數的管理意義名稱
 *   c     : [20, 15]             // 目標函數係數
 *   cons  : [{a:[2,1], sign:'<=', rhs:20, name:'預算限制'}, ...]
 *   nonneg: [true,true]          // 是否有非負限制 xi >= 0
 *   vtype : ['C','C']            // 'C' 連續 / 'I' 整數 / 'B' 0-1
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LPCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 數字工具 ----------
  function clean(v) {
    if (!isFinite(v)) return v;
    const r = Math.round(v * 1e8) / 1e8;
    return Math.abs(r) < 1e-9 ? 0 : r;
  }
  function fmt(v, d) {
    if (d === undefined) d = 4;
    if (v === Infinity) return '∞';
    if (v === -Infinity) return '-∞';
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return String(parseFloat(clean(v).toFixed(d)));
  }
  function num(v) { return String(Number(Number(v).toPrecision(15))); }
  function bigToInf(v) {
    if (v === null || v === undefined) return v;
    if (v >= 1e20) return Infinity;
    if (v <= -1e20) return -Infinity;
    return v;
  }
  function signSym(s) { return s === '<=' ? '≤' : s === '>=' ? '≥' : '='; }

  // ---------- 數學式顯示 ----------
  function termsStr(coefs, names) {
    let s = '', first = true;
    coefs.forEach(function (c, j) {
      if (Math.abs(c) < 1e-12) return;
      const a = Math.abs(c);
      const coef = Math.abs(a - 1) < 1e-12 ? '' : fmt(a);
      if (first) { s += (c < 0 ? '-' : '') + coef + names[j]; first = false; }
      else s += (c < 0 ? ' - ' : ' + ') + coef + names[j];
    });
    return first ? '0' : s;
  }

  function conExpr(model, i) {
    const k = model.cons[i];
    return termsStr(k.a, model.disp) + ' ' + signSym(k.sign) + ' ' + fmt(k.rhs);
  }

  function modelText(model) {
    const L = [];
    L.push((model.sense === 'max' ? 'max' : 'min') + ' Z = ' + termsStr(model.c, model.disp));
    L.push('subject to');
    model.cons.forEach(function (k, i) { L.push('    ' + conExpr(model, i)); });
    const g = { nn: [], free: [], nnInt: [], freeInt: [], bin: [] };
    model.disp.forEach(function (d, j) {
      const t = model.vtype[j], nn = model.nonneg[j];
      if (t === 'B') g.bin.push(d);
      else if (t === 'I') (nn ? g.nnInt : g.freeInt).push(d);
      else (nn ? g.nn : g.free).push(d);
    });
    if (g.nn.length) L.push('    ' + g.nn.join(', ') + ' ≥ 0');
    if (g.nnInt.length) L.push('    ' + g.nnInt.join(', ') + ' ≥ 0 且為整數 (∈ Z)');
    if (g.free.length) L.push('    ' + g.free.join(', ') + ' 為自由變數（可為負值，不限制非負）');
    if (g.freeInt.length) L.push('    ' + g.freeInt.join(', ') + ' ∈ Z（整數，可為負）');
    if (g.bin.length) L.push('    ' + g.bin.join(', ') + ' ∈ {0, 1}');
    return L.join('\n');
  }

  // ---------- CPLEX LP 格式（HiGHS 可讀取） ----------
  function lpExpr(coefs, names, includeZero) {
    const t = [];
    coefs.forEach(function (c, j) {
      if (includeZero || Math.abs(c) > 1e-12) t.push({ c: c, n: names[j] });
    });
    if (!t.length) return '0 ' + names[0];
    return t.map(function (x, idx) {
      if (idx === 0) return num(x.c) + ' ' + x.n;
      return x.c < 0 ? '- ' + num(-x.c) + ' ' + x.n : '+ ' + num(x.c) + ' ' + x.n;
    }).join(' ');
  }

  function toLP(m) {
    const nm = m.names, L = [];
    L.push(m.sense === 'max' ? 'Maximize' : 'Minimize');
    L.push(' obj: ' + lpExpr(m.c, nm, true));
    L.push('Subject To');
    m.cons.forEach(function (k, i) {
      L.push(' c' + (i + 1) + ': ' + lpExpr(k.a, nm, false) + ' ' + (k.sign === '=' ? '=' : k.sign) + ' ' + num(k.rhs));
    });
    const bounds = [], gen = [], bin = [];
    nm.forEach(function (v, j) {
      const t = m.vtype[j];
      if (t === 'B') { bin.push(v); return; }
      bounds.push(' ' + v + (m.nonneg[j] ? ' >= 0' : ' free'));
      if (t === 'I') gen.push(v);
    });
    if (bounds.length) { L.push('Bounds'); bounds.forEach(function (b) { L.push(b); }); }
    if (gen.length) { L.push('Generals'); L.push(' ' + gen.join(' ')); }
    if (bin.length) { L.push('Binary'); L.push(' ' + bin.join(' ')); }
    L.push('End');
    return L.join('\n');
  }

  // ---------- 輸入檢查 ----------
  function validate(model) {
    const errs = [];
    if (!model.c.length) errs.push('至少需要一個決策變數。');
    if (model.c.some(function (v) { return !isFinite(v); })) errs.push('目標函數係數必須是數字。');
    if (!model.cons.length) errs.push('請至少新增一個限制式。');
    model.cons.forEach(function (k, i) {
      if (k.a.some(function (v) { return !isFinite(v); })) errs.push('限制式 ' + (i + 1) + ' 的係數必須是數字。');
      if (!isFinite(k.rhs)) errs.push('限制式 ' + (i + 1) + ' 的右端常數（RHS）必須是數字。');
    });
    return errs;
  }

  // ---------- 求解 ----------
  function statusKind(s) {
    const t = String(s || '').toLowerCase();
    if (t.indexOf('optimal') >= 0) return 'optimal';
    if (t.indexOf('infeasible') >= 0 && t.indexOf('unbounded') >= 0) return 'ambiguous';
    if (t.indexOf('infeasible') >= 0) return 'infeasible';
    if (t.indexOf('unbounded') >= 0) return 'unbounded';
    return 'other';
  }

  function solveModel(model, highs) {
    const lp = toLP(model);
    const isMIP = model.vtype.some(function (t) { return t !== 'C'; });
    let raw;
    try {
      raw = highs.solve(lp, { output_flag: false, presolve: isMIP ? 'choose' : 'off' });
    } catch (e) {
      return { status: 'error', message: String(e && e.message || e), lp: lp, isMIP: isMIP };
    }
    let kind = statusKind(raw.Status);
    if (kind === 'ambiguous') {
      // 無法分辨時，用「目標函數為 0」的問題檢查可行性
      const m0 = Object.assign({}, model, { c: model.c.map(function () { return 0; }) });
      let r0 = null;
      try { r0 = highs.solve(toLP(m0), { output_flag: false, presolve: 'off' }); } catch (e) { /* ignore */ }
      kind = r0 && statusKind(r0.Status) === 'optimal' ? 'unbounded' : 'infeasible';
    }
    const res = { status: kind, rawStatus: raw.Status, lp: lp, isMIP: isMIP };
    if (kind !== 'optimal') return res;

    const n = model.names.length;
    res.x = model.names.map(function (nme, j) {
      let v = raw.Columns[nme] ? raw.Columns[nme].Primal : 0;
      if (model.vtype[j] !== 'C' && Math.abs(v - Math.round(v)) < 1e-6) v = Math.round(v);
      return clean(v);
    });
    // 目標函數值優先採用求解器的結果（避免以四捨五入後的 x 重算而產生 -8.00000001 之類的誤差）
    res.z = isFinite(raw.ObjectiveValue) ? clean(raw.ObjectiveValue)
      : clean(model.c.reduce(function (s, c, j) { return s + c * res.x[j]; }, 0));

    res.rows = model.cons.map(function (k, i) {
      const lhs = clean(k.a.reduce(function (s, a, j) { return s + a * res.x[j]; }, 0));
      const diff = k.sign === '<=' ? k.rhs - lhs : k.sign === '>=' ? lhs - k.rhs : 0;
      const binding = Math.abs(lhs - k.rhs) <= 1e-6 * (1 + Math.abs(k.rhs));
      const rr = raw.Rows && raw.Rows[i];
      return {
        lhs: lhs, rhs: k.rhs, sign: k.sign,
        slack: binding ? 0 : clean(Math.max(diff, 0)),
        binding: binding,
        dual: (!isMIP && rr && rr.Dual !== undefined) ? clean(rr.Dual) : null,
        rhsLow: null, rhsHigh: null
      };
    });
    res.cols = model.names.map(function (nme, j) {
      const cc = raw.Columns[nme] || {};
      return {
        value: res.x[j],
        reduced: (!isMIP && cc.Dual !== undefined) ? clean(cc.Dual) : null,
        basic: cc.Status === 'BS',
        costLow: null, costHigh: null
      };
    });

    res.hasSensitivity = !isMIP;
    if (!isMIP) {
      // 非緊束限制的右端值允許範圍可直接由鬆弛量求得
      res.rows.forEach(function (r) {
        if (r.binding) return;
        if (r.sign === '<=') { r.rhsLow = r.lhs; r.rhsHigh = Infinity; }
        else if (r.sign === '>=') { r.rhsLow = -Infinity; r.rhsHigh = r.lhs; }
      });
      // 緊束限制與目標函數係數的允許範圍：使用 HiGHS ranging
      try {
        const mdl = highs.createModel({ format: 'lp', data: lp });
        try { mdl.options.output_flag = false; } catch (e) { /* ignore */ }
        try { mdl.options.presolve = 'off'; } catch (e) { /* ignore */ }
        try { mdl.options.ranging = 'on'; } catch (e) { /* ignore */ }
        mdl.run();
        const g = mdl.getRanging();
        model.names.forEach(function (nme, j) {
          const idx = raw.Columns[nme].Index;
          res.cols[j].costLow = clean(bigToInf(g.colCostDown.value[idx]));
          res.cols[j].costHigh = clean(bigToInf(g.colCostUp.value[idx]));
        });
        res.rows.forEach(function (r, i) {
          if (!r.binding) return;
          r.rhsLow = clean(bigToInf(g.rowBoundDown.value[i]));
          r.rhsHigh = clean(bigToInf(g.rowBoundUp.value[i]));
        });
        mdl.dispose();
        res.hasRanging = true;
      } catch (e) {
        res.hasRanging = false;
      }
    }
    return res;
  }

  // ---------- 管理意涵 ----------
  function varName(model, j) {
    const lab = model.labels && model.labels[j];
    return lab ? lab + '（' + model.disp[j] + '）' : model.disp[j];
  }
  function conName(model, i) {
    return (model.cons[i].name && String(model.cons[i].name).trim()) || ('限制式 ' + (i + 1));
  }

  function statusMessage(res) {
    if (res.status === 'infeasible') return '無可行解 (Infeasible)：所有限制式無法同時被滿足，請檢查限制式或右端常數是否互相矛盾。';
    if (res.status === 'unbounded') return '無界解 (Unbounded)：目標函數可以無限改善，通常表示遺漏了限制式（例如資源上限），請檢查模型。';
    if (res.status === 'error') return '求解時發生錯誤：' + res.message;
    return '求解器未能求得最佳解（狀態：' + res.rawStatus + '）。';
  }

  function interpretSolution(model, res, opt) {
    opt = opt || {};
    const unit = opt.unit === undefined ? '單位' : opt.unit;
    const objName = (opt.objName && opt.objName.trim()) || (model.sense === 'max' ? '最大目標函數值' : '最小目標函數值');
    const L = [];
    L.push('最佳方案：');
    res.x.forEach(function (v, j) {
      L.push('• ' + varName(model, j) + ' 的最佳決策量為 ' + fmt(v) + (unit ? ' ' + unit : '') + (v === 0 ? '（最佳方案中不採用）' : ''));
    });
    L.push(objName + '為 ' + fmt(res.z) + '。');
    if (res.isMIP) L.push('（此為整數／0-1 規劃問題，最佳解已滿足整數條件。）');
    return L;
  }

  function interpretSensitivity(model, res, opt) {
    opt = opt || {};
    const L = [];
    if (!res.hasSensitivity) {
      L.push('此模型含整數／0-1 變數，屬於整數規劃；影子價格與允許範圍僅在連續線性規劃中有明確定義，因此不提供敏感度分析。');
      return L;
    }
    res.rows.forEach(function (r, i) {
      const nm = conName(model, i);
      const isMaxLe = model.sense === 'max' && r.sign === '<=';
      if (r.binding) {
        if (Math.abs(r.dual || 0) > 1e-9) {
          const up = r.dual > 0;
          let s = '「' + nm + '」為' + (isMaxLe ? '瓶頸資源' : '關鍵（緊束）限制') + '：右端常數每增加 1 單位，目標函數值約' +
            (up ? '增加 ' : '減少 ') + fmt(Math.abs(r.dual)) + ' 單位（影子價格 = ' + fmt(r.dual) + '）';
          if (r.rhsLow !== null && r.rhsHigh !== null) s += '；此影子價格在右端常數介於 ' + fmt(r.rhsLow) + ' ～ ' + fmt(r.rhsHigh) + ' 時有效';
          L.push(s + '。');
        } else {
          L.push('「' + nm + '」雖然等號成立，但影子價格為 0（退化情形），調整其右端常數暫時不會改變目標函數值。');
        }
      } else {
        const what = r.sign === '<=' ? '尚有 ' + fmt(r.slack) + ' 的剩餘資源（鬆弛量）' : '超出下限 ' + fmt(r.slack) + '（剩餘量 Surplus）';
        L.push('「' + nm + '」為非緊束限制，' + what + '，影子價格為 0，在目前範圍內調整此限制不會改變最佳解。');
      }
    });
    res.cols.forEach(function (c, j) {
      if (!c.basic && c.reduced !== null && Math.abs(c.reduced) > 1e-9 && Math.abs(c.value) < 1e-9) {
        L.push(varName(model, j) + ' 在最佳解中為 0；若強迫它增加 1 單位，目標函數值約變動 ' + fmt(c.reduced) + '（減少成本 Reduced Cost）。');
      }
    });
    return L;
  }

  // ---------- 管理科學範本 ----------
  function dispIJ(i, j, m, n) { return (m < 10 && n < 10) ? 'x' + (i + 1) + (j + 1) : 'x' + (i + 1) + ',' + (j + 1); }

  /**
   * 運輸問題：min Σ c_ij x_ij
   *   供給：Σ_j x_ij ≤ s_i ； 需求：Σ_i x_ij ≥ d_j ； x_ij ≥ 0
   */
  function buildTransport(p) {
    const m = p.supply.length, n = p.demand.length;
    const names = [], disp = [], labels = [], c = [], nonneg = [], vtype = [];
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
      names.push('x_' + (i + 1) + '_' + (j + 1));
      disp.push(dispIJ(i, j, m, n));
      labels.push((p.supplyNames[i] || 'S' + (i + 1)) + ' → ' + (p.demandNames[j] || 'D' + (j + 1)));
      c.push(p.cost[i][j]); nonneg.push(true); vtype.push('C');
    }
    const cons = [];
    for (let i = 0; i < m; i++) {
      const a = new Array(m * n).fill(0);
      for (let j = 0; j < n; j++) a[i * n + j] = 1;
      cons.push({ a: a, sign: '<=', rhs: p.supply[i], name: '供給：' + (p.supplyNames[i] || 'S' + (i + 1)) });
    }
    for (let j = 0; j < n; j++) {
      const a = new Array(m * n).fill(0);
      for (let i = 0; i < m; i++) a[i * n + j] = 1;
      cons.push({ a: a, sign: '>=', rhs: p.demand[j], name: '需求：' + (p.demandNames[j] || 'D' + (j + 1)) });
    }
    return { sense: 'min', names: names, disp: disp, labels: labels, c: c, cons: cons, nonneg: nonneg, vtype: vtype };
  }

  /**
   * 指派問題：每位人員至多（或恰好）指派一項工作，每項工作至多（或恰好）一位人員。
   * 較少的一方必須全部被指派（= 1），較多的一方至多一次（≤ 1）。
   */
  function buildAssignment(p) {
    const m = p.cost.length, n = p.cost[0].length;
    const names = [], disp = [], labels = [], c = [], nonneg = [], vtype = [];
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
      names.push('x_' + (i + 1) + '_' + (j + 1));
      disp.push(dispIJ(i, j, m, n));
      labels.push((p.rowNames[i] || '人員' + (i + 1)) + ' → ' + (p.colNames[j] || '工作' + (j + 1)));
      c.push(p.cost[i][j]); nonneg.push(true); vtype.push('C');
    }
    const cons = [];
    const rowSign = m <= n ? '=' : '<=';
    const colSign = n <= m ? '=' : '<=';
    for (let i = 0; i < m; i++) {
      const a = new Array(m * n).fill(0);
      for (let j = 0; j < n; j++) a[i * n + j] = 1;
      cons.push({ a: a, sign: rowSign, rhs: 1, name: (p.rowNames[i] || '人員' + (i + 1)) + ' 的指派限制' });
    }
    for (let j = 0; j < n; j++) {
      const a = new Array(m * n).fill(0);
      for (let i = 0; i < m; i++) a[i * n + j] = 1;
      cons.push({ a: a, sign: colSign, rhs: 1, name: (p.colNames[j] || '工作' + (j + 1)) + ' 的指派限制' });
    }
    return { sense: p.sense || 'min', names: names, disp: disp, labels: labels, c: c, cons: cons, nonneg: nonneg, vtype: vtype };
  }

  return {
    clean: clean, fmt: fmt, signSym: signSym,
    termsStr: termsStr, conExpr: conExpr, modelText: modelText, toLP: toLP,
    validate: validate, solveModel: solveModel,
    varName: varName, conName: conName,
    statusMessage: statusMessage, interpretSolution: interpretSolution, interpretSensitivity: interpretSensitivity,
    buildTransport: buildTransport, buildAssignment: buildAssignment
  };
});
