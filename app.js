/*
 * app.js — 網頁版線性規劃計算器 主程式
 * 流程：使用者輸入 → 自動建立數學模型 → 呼叫 HiGHS 求解 → 結果與敏感度分析
 */
(function () {
  'use strict';
  const L = window.LPCore;
  const F = L.fmt;
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  const esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };

  /* ================= 重畫表格時保留使用者剛點選的欄位 =================
   * 修改「變數個數／供給地數量」後直接點下一個格子時，瀏覽器會先讓數量欄失焦並觸發 change，
   * 表格因此被重畫，使用者剛點的格子被刪掉，焦點掉回頁面、輸入的數字就打不進去。
   * 解法：記下最後一次按下滑鼠／觸控的欄位，重畫後依 data 屬性找回同一格並重新聚焦。 */
  let lastDown = null;
  function rememberDown(e) { lastDown = { el: e.target, t: Date.now() }; }
  document.addEventListener('mousedown', rememberDown, true);
  document.addEventListener('touchstart', rememberDown, true);
  function selectorFor(el) {
    let s = el.tagName.toLowerCase();
    ['f', 't', 'i', 'j'].forEach(function (k) { if (el.dataset[k] !== undefined) s += '[data-' + k + '="' + el.dataset[k] + '"]'; });
    return s;
  }
  function restoreFocus() {
    const d = lastDown;
    if (!d || Date.now() - d.t > 800 || d.el.isConnected) return;
    if (!d.el.dataset || !(d.el.dataset.f || d.el.dataset.t)) return;
    const n = document.querySelector(selectorFor(d.el));
    if (n) { n.focus(); if (n.select) { try { n.select(); } catch (e) { /* ignore */ } } }
  }

  /* ================= 輸入變更後，提醒結果已過期 ================= */
  function markStale(box, extraCards) {
    if (!box || box.querySelector('.stale-note') || box.querySelector('.loading') || !box.querySelector('.card')) return;
    box.insertAdjacentHTML('afterbegin', '<div class="banner warn stale-note">輸入資料已變更，下方仍是「上一次」的結果，請重新按「求解」。</div>');
    $$('.card', box).forEach(function (c) { c.style.opacity = '0.45'; });
    (extraCards || []).forEach(function (sel) { const c = $(sel); if (c && !c.hidden) c.style.opacity = '0.45'; });
  }
  function watchStale(panelSel, resultSel, extraCards) {
    const panel = $(panelSel), box = $(resultSel);
    function on(e) {
      if (box.contains(e.target)) return;
      if (e.type === 'click') {
        const t = e.target.closest('button');
        if (!t || !(t.id === 'g-addcon' || t.dataset.act === 'delcon')) return;
      }
      markStale(box, extraCards);
    }
    panel.addEventListener('input', on);
    panel.addEventListener('change', on);
    panel.addEventListener('click', on);
    (extraCards || []).forEach(function (sel) { const c = $(sel); if (c) c.style.opacity = ''; });
  }

  /* ================= 求解器載入 ================= */
  let highsPromise = null;
  function getHighs() {
    if (highsPromise) return highsPromise;
    highsPromise = (async function () {
      if (typeof Module !== 'function' || !window.HIGHS_WASM_B64) {
        throw new Error('找不到求解器檔案（lib/highs.js、lib/highs-wasm.js），請確認壓縮檔已完整解壓縮。');
      }
      const bin = atob(window.HIGHS_WASM_B64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // 以 instantiateWasm 介面直接使用內嵌的 wasm 位元組（避免 file:// 下 fetch 被瀏覽器擋下）
      return await Module({
        instantiateWasm: function (imports, receive) {
          WebAssembly.instantiate(bytes, imports).then(function (r) { receive(r.instance); })
            .catch(function (e) { console.error(e); });
          return {};
        }
      });
    })();
    return highsPromise;
  }
  (function initBadge() {
    const b = $('#solver-badge');
    getHighs().then(function () {
      b.className = 'solver-badge ready'; b.textContent = 'HiGHS 求解器已就緒';
    }).catch(function (e) {
      b.className = 'solver-badge fail'; b.textContent = '求解器載入失敗';
      console.error(e);
    });
  })();

  /* ================= 數字解析 ================= */
  function parseNum(s) {
    s = String(s === undefined || s === null ? '' : s).trim();
    if (s === '') return NaN;
    const m = s.match(/^([+-]?\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/);
    if (m) { const d = Number(m[2]); return d === 0 ? NaN : Number(m[1]) / d; }
    const v = Number(s);
    return isFinite(v) ? v : NaN;
  }
  function coef(s) { return String(s === undefined ? '' : s).trim() === '' ? 0 : parseNum(s); }
  function markInvalid(el, isCoef) {
    const v = el.value.trim();
    const bad = isCoef ? (v !== '' && isNaN(parseNum(v))) : (v === '' ? false : isNaN(parseNum(v)));
    el.classList.toggle('invalid', bad);
  }

  /* ================= 結果呈現 ================= */
  function table(headers, rows, aligns) {
    aligns = aligns || [];
    let h = '<table class="data"><thead><tr>';
    headers.forEach(function (t, i) { h += '<th class="' + (aligns[i] || '') + '">' + t + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr>';
      r.forEach(function (c, i) { h += '<td class="' + (aligns[i] || '') + '">' + c + '</td>'; });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }
  function linesToHTML(lines) {
    let html = '', inList = false;
    lines.forEach(function (ln) {
      if (ln.indexOf('• ') === 0) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + esc(ln.slice(2)) + '</li>';
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p>' + esc(ln) + '</p>';
      }
    });
    if (inList) html += '</ul>';
    return html;
  }
  const badgeBind = '<span class="badge bind">Binding（等號成立）</span>';
  const badgeNon = '<span class="badge non">Nonbinding</span>';

  let lastGraph = null;
  function graphLegendHTML(items) {
    return items.map(function (it) {
      return '<li><span class="sw ' + it.type + '" style="background:' + it.color + '"></span>' + esc(it.text) + '</li>';
    }).join('');
  }
  function drawGraphInto(box, model, res) {
    const cv = $('canvas.graph', box);
    if (!cv) return;
    lastGraph = { cv: cv, model: model, res: res };
    const items = window.LPGraph.drawGraph(cv, model, res);
    $('.legend', box).innerHTML = graphLegendHTML(items);
  }
  window.addEventListener('resize', function () {
    if (lastGraph && lastGraph.cv.isConnected && lastGraph.cv.clientWidth > 0) window.LPGraph.drawGraph(lastGraph.cv, lastGraph.model, lastGraph.res);
  });

  /**
   * 通用結果顯示。
   * o: { objName, unit, graph, solutionHTML, analysisHTML }
   */
  function renderResults(box, model, res, o) {
    o = o || {};
    const objName = (o.objName && o.objName.trim()) || (model.sense === 'max' ? '最大目標函數值' : '最小目標函數值');
    const n = model.c.length;
    let html = '';

    if (res.status !== 'optimal') {
      html += '<div class="banner err">' + esc(L.statusMessage(res)) + '</div>';
      if (o.graph && n === 2 && res.status !== 'error') {
        html += graphCard();
      }
      html += lpDetails(res);
      box.innerHTML = html;
      if (o.graph && n === 2 && res.status !== 'error') drawGraphInto(box, model, res);
      return;
    }

    html += '<div class="card"><h2>求解結果</h2>';
    html += '<div class="banner ok">已求得最佳解（Optimal）</div>';
    if (o.solutionHTML) {
      html += o.solutionHTML;
    } else {
      const rows = res.x.map(function (v, j) {
        return ['<span class="xname">x*<sub>' + esc(model.disp[j].replace(/^x/, '')) + '</sub></span>', esc(model.labels && model.labels[j] ? model.labels[j] : '—'), '<b>' + F(v) + '</b>'];
      });
      html += table(['最佳解', '管理意義', '最佳值'], rows, ['', '', 'n']);
      html += '<div class="bigz"><span class="lbl">最佳目標函數值 Z*</span><span class="z">' + F(res.z) + '</span><span class="lbl">（' + esc(objName) + '）</span></div>';
      html += '<div class="meaning"><b>求解結果解讀</b>' + linesToHTML(L.interpretSolution(model, res, { unit: o.unit, objName: o.objName })) + '</div>';
    }
    html += '</div>';

    if (o.analysisHTML) html += '<div class="card">' + o.analysisHTML + '</div>';

    // 限制式分析
    html += '<div class="card"><h2>限制式分析（Constraint Analysis）</h2>';
    html += table(['限制式', '左側值', '右側值', '狀態', 'Slack／Surplus'], res.rows.map(function (r, i) {
      const lbl = r.sign === '<=' ? 'Slack' : r.sign === '>=' ? 'Surplus' : '—';
      return [
        '<b>' + esc(L.conName(model, i)) + '</b><br><span class="mono" style="font-size:12.5px;color:var(--muted)">' + esc(model.cons.length > 14 ? '' : L.conExpr(model, i)) + '</span>',
        F(r.lhs), F(r.rhs),
        r.binding ? badgeBind : badgeNon,
        r.sign === '=' ? '—' : (lbl + ' = ' + F(r.slack))
      ];
    }), ['', 'n', 'n', '', 'n']);
    html += '<p class="hint" style="margin-top:8px">Binding：最佳解時等號成立，代表該資源用盡（或需求剛好滿足）；Nonbinding：尚有剩餘，並未限制最佳解。</p></div>';

    // 敏感度分析
    html += '<div class="card"><h2>敏感度分析（Sensitivity Analysis）</h2>';
    if (!res.hasSensitivity) {
      html += '<div class="banner warn" style="font-weight:500">' + esc(L.interpretSensitivity(model, res)[0]) + '</div>';
    } else {
      html += '<h3 style="margin-top:0">限制式：影子價格與右端常數允許範圍</h3>';
      html += table(['限制式', 'Shadow Price（影子價格）', 'Slack', '狀態', '右端常數 RHS 允許範圍'], res.rows.map(function (r, i) {
        const range = (r.rhsLow !== null && r.rhsHigh !== null) ? F(r.rhsLow) + ' ～ ' + F(r.rhsHigh) : '—';
        return [esc(L.conName(model, i)), '<b>' + F(r.dual) + '</b>', r.sign === '=' ? '—' : F(r.slack), r.binding ? badgeBind : badgeNon, range];
      }), ['', 'n', 'n', '', 'n']);
      html += '<h3>決策變數：目標係數允許範圍與減少成本</h3>';
      html += table(['變數', '最佳值', '目標函數係數', '係數允許範圍（最佳基底不變）', 'Reduced Cost', '基底狀態'], res.cols.map(function (c, j) {
        const range = (c.costLow !== null && c.costHigh !== null) ? F(c.costLow) + ' ～ ' + F(c.costHigh) : '—';
        return [esc(L.varName(model, j)), F(c.value), F(model.c[j]), range, F(c.reduced), c.basic ? '基變數' : '非基變數'];
      }), ['', 'n', 'n', 'n', 'n', '']);
      html += '<div class="meaning"><b>管理意涵</b>' + linesToHTML(L.interpretSensitivity(model, res)) + '</div>';
      html += '<p class="hint" style="margin-top:8px">影子價格 = 右端常數增加 1 單位時目標函數值的變化量，僅在「右端常數允許範圍」內成立；目標係數落在允許範圍內時，最佳解不變（但目標函數值會隨之改變）。</p>';
    }
    html += '</div>';

    if (o.graph && n === 2) html += graphCard();
    html += lpDetails(res);
    box.innerHTML = html;
    if (o.graph && n === 2) drawGraphInto(box, model, res);
  }
  function graphCard() {
    return '<div class="card"><h2>圖形化分析</h2><canvas class="graph" role="img" aria-label="限制式、可行區域、最佳解與等利潤線圖"></canvas><ul class="legend"></ul></div>';
  }
  function lpDetails(res) {
    return '<details><summary>查看傳送給求解器的模型（CPLEX LP 格式）</summary><pre>' + esc(res.lp || '') + '</pre></details>';
  }

  async function runSolve(btn, box, model, o) {
    const errs = L.validate(model);
    if (errs.length) {
      box.innerHTML = '<div class="banner err">' + errs.map(esc).join('<br>') + '</div>';
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return null;
    }
    btn.disabled = true;
    box.innerHTML = '<div class="loading">求解中…</div>';
    try {
      const highs = await getHighs();
      await new Promise(function (r) { setTimeout(r, 20); });
      const res = L.solveModel(model, highs);
      renderResults(box, model, res, o);
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return res;
    } catch (e) {
      box.innerHTML = '<div class="banner err">' + esc(e.message || String(e)) + '</div>';
      return null;
    } finally {
      btn.disabled = false;
    }
  }

  /* ================= 一般線性規劃 ================= */
  const EXAMPLES = {
    hw: {
      sense: 'max', n: 2, labels: ['產品A', '產品B'], nonneg: [true, true], vtype: ['C', 'C'], c: ['20', '15'],
      cons: [{ name: '預算限制', a: ['2', '1'], sign: '<=', rhs: '20' }, { name: '人力限制', a: ['1', '3'], sign: '<=', rhs: '35' }],
      objName: '最大利潤', unit: '單位'
    },
    prod3: {
      sense: 'max', n: 3, labels: ['產品A', '產品B', '產品C'], nonneg: [true, true, true], vtype: ['C', 'C', 'C'], c: ['5', '4', '3'],
      cons: [{ name: '原料1', a: ['2', '3', '1'], sign: '<=', rhs: '5' }, { name: '原料2', a: ['4', '1', '2'], sign: '<=', rhs: '11' }, { name: '原料3', a: ['3', '4', '2'], sign: '<=', rhs: '8' }],
      objName: '最大利潤', unit: '單位'
    },
    diet: {
      sense: 'min', n: 2, labels: ['食物A', '食物B'], nonneg: [true, true], vtype: ['C', 'C'], c: ['0.6', '0.35'],
      cons: [{ name: '營養素1', a: ['5', '7'], sign: '>=', rhs: '8' }, { name: '營養素2', a: ['4', '2'], sign: '>=', rhs: '15' }, { name: '營養素3', a: ['2', '1'], sign: '>=', rhs: '3' }],
      objName: '最小成本', unit: '份'
    },
    int: {
      sense: 'max', n: 2, labels: ['椅子', '桌子'], nonneg: [true, true], vtype: ['I', 'I'], c: ['30', '50'],
      cons: [{ name: '木工時數', a: ['1', '2'], sign: '<=', rhs: '40' }, { name: '加工時數', a: ['2', '1'], sign: '<=', rhs: '50' }],
      objName: '最大利潤', unit: '張'
    },
    knap: {
      sense: 'max', n: 4, labels: ['專案A', '專案B', '專案C', '專案D'], nonneg: [true, true, true, true], vtype: ['B', 'B', 'B', 'B'], c: ['10', '13', '7', '8'],
      cons: [{ name: '預算限制', a: ['3', '4', '2', '3'], sign: '<=', rhs: '7' }],
      objName: '最大總效益', unit: ''
    },
    infeasible: {
      sense: 'max', n: 2, labels: ['', ''], nonneg: [true, true], vtype: ['C', 'C'], c: ['1', '1'],
      cons: [{ name: '', a: ['1', '1'], sign: '<=', rhs: '4' }, { name: '', a: ['1', '1'], sign: '>=', rhs: '6' }],
      objName: '', unit: '單位'
    },
    unbounded: {
      sense: 'max', n: 2, labels: ['', ''], nonneg: [true, true], vtype: ['C', 'C'], c: ['1', '1'],
      cons: [{ name: '', a: ['1', '-1'], sign: '<=', rhs: '2' }],
      objName: '', unit: '單位'
    }
  };

  const G = {};
  function setG(src) {
    G.sense = src.sense; G.n = src.n;
    G.labels = src.labels.slice(); G.nonneg = src.nonneg.slice(); G.vtype = src.vtype.slice(); G.c = src.c.slice();
    G.cons = src.cons.map(function (k) { return { name: k.name, a: k.a.slice(), sign: k.sign, rhs: k.rhs }; });
    G.objName = src.objName; G.unit = src.unit;
  }
  function blankG() {
    return { sense: 'max', n: 2, labels: ['', ''], nonneg: [true, true], vtype: ['C', 'C'], c: ['', ''], cons: [{ name: '', a: ['', ''], sign: '<=', rhs: '' }], objName: '', unit: '單位' };
  }

  function resizeG(n) {
    n = Math.max(1, Math.min(12, n | 0));
    while (G.labels.length < n) { G.labels.push(''); G.nonneg.push(true); G.vtype.push('C'); G.c.push(''); G.cons.forEach(function (k) { k.a.push(''); }); }
    G.labels.length = G.nonneg.length = G.vtype.length = G.c.length = n;
    G.cons.forEach(function (k) { k.a.length = n; });
    G.n = n;
  }

  function sub(j) { return 'x' + (j + 1); }
  function modelFromG(preview) {
    const f = preview ? function (v) { return isFinite(v) ? v : 0; } : function (v) { return v; };
    const names = [], disp = [];
    for (let j = 0; j < G.n; j++) { names.push(sub(j)); disp.push(sub(j)); }
    return {
      sense: G.sense, names: names, disp: disp, labels: G.labels.map(function (s) { return s.trim(); }),
      c: G.c.map(function (s) { return f(coef(s)); }),
      cons: G.cons.map(function (k) { return { a: k.a.map(function (s) { return f(coef(s)); }), sign: k.sign, rhs: f(parseNum(k.rhs)), name: k.name }; }),
      nonneg: G.nonneg.slice(), vtype: G.vtype.slice()
    };
  }

  function renderVars() {
    let h = '<table class="grid"><thead><tr><th>變數</th><th>管理意義名稱（選填）</th><th>非負限制</th><th>變數型態</th></tr></thead><tbody>';
    for (let j = 0; j < G.n; j++) {
      const isB = G.vtype[j] === 'B';
      h += '<tr><td class="xname">' + sub(j) + '</td>' +
        '<td><input type="text" class="cname" data-f="label" data-j="' + j + '" value="' + esc(G.labels[j]) + '" placeholder="例：產品' + String.fromCharCode(65 + j) + '" aria-label="' + sub(j) + ' 名稱"></td>' +
        '<td><label><input type="checkbox" data-f="nonneg" data-j="' + j + '"' + (G.nonneg[j] || isB ? ' checked' : '') + (isB ? ' disabled' : '') + '> ' + sub(j) + ' ≥ 0</label></td>' +
        '<td><select data-f="vtype" data-j="' + j + '" aria-label="' + sub(j) + ' 型態">' +
        '<option value="C"' + (G.vtype[j] === 'C' ? ' selected' : '') + '>連續（實數）</option>' +
        '<option value="I"' + (G.vtype[j] === 'I' ? ' selected' : '') + '>整數 (' + sub(j) + ' ∈ Z)</option>' +
        '<option value="B"' + (G.vtype[j] === 'B' ? ' selected' : '') + '>0-1 (' + sub(j) + ' ∈ {0, 1})</option>' +
        '</select></td></tr>';
    }
    $('#g-vars').innerHTML = h + '</tbody></table>';
  }
  function renderObj() {
    let h = '<div class="objline"><span class="lbl">' + (G.sense === 'max' ? 'max' : 'min') + ' Z =</span>';
    for (let j = 0; j < G.n; j++) {
      if (j) h += '<span class="plus">+</span>';
      h += '<input type="text" class="num" inputmode="decimal" data-f="c" data-j="' + j + '" value="' + esc(G.c[j]) + '" placeholder="0" aria-label="' + sub(j) + ' 的係數"><span class="var">' + sub(j) + '</span>';
    }
    $('#g-obj').innerHTML = h + '</div><p class="hint" style="margin-top:8px">在各變數前輸入目標函數係數（可用小數或分數）。</p>';
  }
  function renderCons() {
    let h = '<table class="grid"><thead><tr><th>#</th><th>名稱（選填）</th>';
    for (let j = 0; j < G.n; j++) h += '<th class="xname">' + sub(j) + '</th>';
    h += '<th>符號</th><th>RHS</th><th></th></tr></thead><tbody>';
    G.cons.forEach(function (k, i) {
      h += '<tr><td class="mono">' + (i + 1) + '</td><td><input type="text" class="cname" data-f="cname" data-i="' + i + '" value="' + esc(k.name) + '" placeholder="例：預算限制" aria-label="限制式 ' + (i + 1) + ' 名稱"></td>';
      for (let j = 0; j < G.n; j++) h += '<td><input type="text" class="num" inputmode="decimal" data-f="a" data-i="' + i + '" data-j="' + j + '" value="' + esc(k.a[j]) + '" placeholder="0" aria-label="限制式 ' + (i + 1) + ' 的 ' + sub(j) + ' 係數"></td>';
      h += '<td><select data-f="sign" data-i="' + i + '" aria-label="限制式 ' + (i + 1) + ' 符號">' +
        ['<=', '=', '>='].map(function (s) { return '<option value="' + s + '"' + (k.sign === s ? ' selected' : '') + '>' + L.signSym(s) + '</option>'; }).join('') +
        '</select></td>' +
        '<td><input type="text" class="num" inputmode="decimal" data-f="rhs" data-i="' + i + '" value="' + esc(k.rhs) + '" placeholder="RHS" aria-label="限制式 ' + (i + 1) + ' 右端常數"></td>' +
        '<td><button class="btn mini danger" data-act="delcon" data-i="' + i + '" aria-label="刪除限制式 ' + (i + 1) + '">刪除</button></td></tr>';
    });
    $('#g-cons').innerHTML = h + '</tbody></table>';
  }
  function refreshModel() { $('#g-model').textContent = L.modelText(modelFromG(true)); }
  function renderAllG() {
    $('#g-n').value = G.n;
    $('#g-objname').value = G.objName; $('#g-unit').value = G.unit;
    $$('input[name=sense]').forEach(function (r) { r.checked = r.value === G.sense; });
    renderVars(); renderObj(); renderCons(); refreshModel();
    restoreFocus();
  }

  (function wireGeneral() {
    const panel = $('#tab-general');
    panel.addEventListener('input', function (e) {
      const t = e.target, f = t.dataset.f;
      if (!f) return;
      const i = +t.dataset.i, j = +t.dataset.j;
      if (f === 'label') G.labels[j] = t.value;
      else if (f === 'c') { G.c[j] = t.value; markInvalid(t, true); }
      else if (f === 'a') { G.cons[i].a[j] = t.value; markInvalid(t, true); }
      else if (f === 'rhs') { G.cons[i].rhs = t.value; markInvalid(t, false); }
      else if (f === 'cname') G.cons[i].name = t.value;
      else return;
      refreshModel();
    });
    panel.addEventListener('change', function (e) {
      const t = e.target, f = t.dataset.f;
      if (!f) return;
      const i = +t.dataset.i, j = +t.dataset.j;
      if (f === 'nonneg') G.nonneg[j] = t.checked;
      else if (f === 'vtype') { G.vtype[j] = t.value; if (t.value === 'B') G.nonneg[j] = true; renderVars(); }
      else if (f === 'sign') G.cons[i].sign = t.value;
      refreshModel();
    });
    panel.addEventListener('click', function (e) {
      const b = e.target.closest('[data-act=delcon]');
      if (!b) return;
      if (G.cons.length <= 1) { G.cons[0] = { name: '', a: G.c.map(function () { return ''; }), sign: '<=', rhs: '' }; }
      else G.cons.splice(+b.dataset.i, 1);
      renderCons(); refreshModel();
    });
    $$('input[name=sense]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { G.sense = r.value; renderObj(); refreshModel(); } });
    });
    $('#g-n').addEventListener('change', function () {
      let v = parseInt(this.value, 10); if (!(v >= 1)) v = G.n;
      resizeG(v); renderAllG();
    });
    $('#g-objname').addEventListener('input', function () { G.objName = this.value; });
    $('#g-unit').addEventListener('input', function () { G.unit = this.value; });
    $('#g-addcon').addEventListener('click', function () {
      G.cons.push({ name: '', a: G.c.map(function () { return ''; }), sign: '<=', rhs: '' });
      renderCons(); refreshModel();
    });
    $('#g-example').addEventListener('change', function () {
      if (EXAMPLES[this.value]) { setG(EXAMPLES[this.value]); renderAllG(); $('#g-result').innerHTML = ''; }
      this.value = '';
    });
    $('#g-reset').addEventListener('click', function () { setG(blankG()); renderAllG(); $('#g-result').innerHTML = ''; });
    $('#g-solve').addEventListener('click', function () {
      const model = modelFromG(false);
      // 標示有問題的欄位
      $$('#tab-general input[data-f=c], #tab-general input[data-f=a], #tab-general input[data-f=rhs]').forEach(function (el) {
        markInvalid(el, el.dataset.f !== 'rhs');
        if (el.dataset.f === 'rhs' && el.value.trim() === '') el.classList.add('invalid');
      });
      runSolve(this, $('#g-result'), model, { objName: G.objName, unit: G.unit, graph: true });
    });
  })();

  /* ================= 管理科學範本：共用矩陣表單 ================= */
  function sizeOf(v, d) { v = parseInt(v, 10); return v >= 1 ? Math.min(v, 8) : d; }

  function resizeMatrix(S, m, n, cfg) {
    while (S.rowNames.length < m) { S.rowNames.push(cfg.rowPrefix + (S.rowNames.length + 1)); S.cost.push([]); if (cfg.caps) S.supply.push(''); }
    S.rowNames.length = m; S.cost.length = m; if (cfg.caps) S.supply.length = m;
    while (S.colNames.length < n) { S.colNames.push(cfg.colPrefix + (S.colNames.length + 1)); if (cfg.caps) S.demand.push(''); }
    S.colNames.length = n; if (cfg.caps) S.demand.length = n;
    S.cost.forEach(function (r) { while (r.length < n) r.push(''); r.length = n; });
    S.m = m; S.n = n;
  }

  function matrixFormHTML(S, cfg) {
    let h = '<table class="mat"><thead><tr><th class="corner">' + cfg.costTitle + '</th>';
    for (let j = 0; j < S.n; j++) h += '<th><input type="text" class="name" data-t="colname" data-j="' + j + '" value="' + esc(S.colNames[j]) + '" aria-label="' + cfg.colWord + ' ' + (j + 1) + ' 名稱"></th>';
    if (cfg.caps) h += '<th>供應量<br>Supply</th>';
    h += '</tr></thead><tbody>';
    for (let i = 0; i < S.m; i++) {
      h += '<tr><th><input type="text" class="name" data-t="rowname" data-i="' + i + '" value="' + esc(S.rowNames[i]) + '" aria-label="' + cfg.rowWord + ' ' + (i + 1) + ' 名稱"></th>';
      for (let j = 0; j < S.n; j++) h += '<td><input type="text" class="num" inputmode="decimal" data-t="cost" data-i="' + i + '" data-j="' + j + '" value="' + esc(S.cost[i][j]) + '" placeholder="0" aria-label="' + esc(S.rowNames[i]) + ' 到 ' + esc(S.colNames[j]) + ' 的成本"></td>';
      if (cfg.caps) h += '<td><input type="text" class="num" inputmode="decimal" data-t="supply" data-i="' + i + '" value="' + esc(S.supply[i]) + '" placeholder="供應量" aria-label="' + esc(S.rowNames[i]) + ' 供應量"></td>';
      h += '</tr>';
    }
    if (cfg.caps) {
      h += '<tr><th class="corner">需求量<br>Demand</th>';
      for (let j = 0; j < S.n; j++) h += '<td><input type="text" class="num" inputmode="decimal" data-t="demand" data-j="' + j + '" value="' + esc(S.demand[j]) + '" placeholder="需求量" aria-label="' + esc(S.colNames[j]) + ' 需求量"></td>';
      h += '<td></td></tr>';
    }
    return h + '</tbody></table>';
  }

  function wireMatrix(panelSel, formSel, S, cfg, onChange) {
    const form = $(formSel);
    function render() { form.innerHTML = matrixFormHTML(S, cfg); onChange(); }
    form.addEventListener('input', function (e) {
      const t = e.target, k = t.dataset.t;
      if (!k) return;
      const i = +t.dataset.i, j = +t.dataset.j;
      if (k === 'cost') { S.cost[i][j] = t.value; markInvalid(t, true); }
      else if (k === 'supply') { S.supply[i] = t.value; markInvalid(t, false); }
      else if (k === 'demand') { S.demand[j] = t.value; markInvalid(t, false); }
      else if (k === 'rowname') S.rowNames[i] = t.value;
      else if (k === 'colname') S.colNames[j] = t.value;
      onChange();
    });
    return render;
  }

  // 成本矩陣不可留白：留白若被當成 0，會讓「沒填的路線」變成免費路線而得到錯誤答案。
  // 傳入 formSel 時，會把空白或無法辨識的格子標紅。
  function matrixNums(S, formSel) {
    return S.cost.map(function (r, i) {
      return r.map(function (s, j) {
        const v = String(s).trim() === '' ? NaN : parseNum(s);
        if (formSel) {
          const el = $(formSel + ' input[data-t=cost][data-i="' + i + '"][data-j="' + j + '"]');
          if (el) el.classList.toggle('invalid', isNaN(v));
        }
        return v;
      });
    });
  }

  /* ================= 運輸問題 ================= */
  const T = { m: 3, n: 4, rowNames: [], colNames: [], cost: [], supply: [], demand: [] };
  const T_CFG = { caps: true, rowPrefix: 'S', colPrefix: 'D', costTitle: '運輸成本 cᵢⱼ', rowWord: '供給地', colWord: '需求地' };
  const T_EXAMPLE = {
    rowNames: ['S1', 'S2', 'S3'], colNames: ['A', 'B', 'C', 'D'],
    cost: [['16', '18', '11', '20'], ['14', '12', '13', '17'], ['13', '15', '17', '18']],
    supply: ['300', '300', '200'], demand: ['150', '250', '200', '200']
  };

  function transportInput() {
    const cost = matrixNums(T, '#t-form');
    const supply = T.supply.map(parseNum), demand = T.demand.map(parseNum);
    return { cost: cost, supply: supply, demand: demand };
  }
  function updateBalance() {
    const el = $('#t-balance');
    const s = T.supply.map(parseNum), d = T.demand.map(parseNum);
    if (s.some(isNaN) || d.some(isNaN)) { el.className = 'balance'; el.textContent = '請輸入所有供應量與需求量。'; return; }
    const S = s.reduce(function (a, b) { return a + b; }, 0), D = d.reduce(function (a, b) { return a + b; }, 0);
    if (Math.abs(S - D) < 1e-9) { el.className = 'balance'; el.textContent = '總供給 = ' + F(S) + '，總需求 = ' + F(D) + '（供需平衡）。'; }
    else if (S > D) { el.className = 'balance warn'; el.textContent = '總供給 = ' + F(S) + ' > 總需求 = ' + F(D) + '：供給大於需求，部分供應量將會剩餘（模型使用「供給 ≤ 供應量」）。'; }
    else { el.className = 'balance bad'; el.textContent = '總供給 = ' + F(S) + ' < 總需求 = ' + F(D) + '：供給不足，將無法滿足所有需求（求解時會顯示無可行解）。'; }
  }
  function buildTransportModel(strict) {
    const inp = transportInput();
    const errs = [];
    if (inp.cost.some(function (r) { return r.some(isNaN); })) errs.push('運輸成本矩陣有空白或無法辨識的格子（已標紅），請填入每一格的單位運輸成本。');
    if (inp.supply.some(function (v) { return isNaN(v) || v < 0; })) errs.push('每個供給地都必須輸入非負的供應量。');
    if (inp.demand.some(function (v) { return isNaN(v) || v < 0; })) errs.push('每個需求地都必須輸入非負的需求量。');
    if (errs.length) return { errs: errs };
    const model = L.buildTransport({ supply: inp.supply, demand: inp.demand, cost: inp.cost, supplyNames: T.rowNames.map(function (s) { return s.trim(); }), demandNames: T.colNames.map(function (s) { return s.trim(); }) });
    return { model: model };
  }
  function showTransportModel(model) {
    $('#t-model-card').hidden = false; $('#t-model-card').style.opacity = '';
    $('#t-model-hint').textContent = 'xᵢⱼ = 由供給地 i 運至需求地 j 的數量；目標函數 min Z = Σᵢ Σⱼ cᵢⱼ xᵢⱼ；並自動建立供給限制（Σⱼ xᵢⱼ ≤ 供應量）與需求限制（Σᵢ xᵢⱼ ≥ 需求量）。';
    $('#t-model').textContent = L.modelText(model);
  }

  function transportSolutionHTML(model, res) {
    const m = T.m, n = T.n;
    const sn = function (i) { return T.rowNames[i].trim() || 'S' + (i + 1); };
    const dn = function (j) { return T.colNames[j].trim() || 'D' + (j + 1); };
    const cost = matrixNums(T);
    const rows = [];
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
      const v = res.x[i * n + j];
      if (v > 1e-9) rows.push([esc(sn(i)), esc(dn(j)), '<b>' + F(v) + '</b>', F(cost[i][j]), F(v * cost[i][j])]);
    }
    let h = '<h3 style="margin-top:0">最佳運輸方案</h3>';
    h += table(['來源地', '目的地', '最佳運輸量', '單位運輸成本', '成本小計'], rows, ['', '', 'n', 'n', 'n']);
    h += '<div class="bigz"><span class="lbl">最小總運輸成本 Z*</span><span class="z">' + F(res.z) + '</span></div>';
    // 運輸量矩陣
    let mt = '<h3>運輸量矩陣（列＝來源地，欄＝目的地）</h3><div class="scroll"><table class="data"><thead><tr><th></th>';
    for (let j = 0; j < n; j++) mt += '<th class="n">' + esc(dn(j)) + '</th>';
    mt += '<th class="n">運出合計</th></tr></thead><tbody>';
    for (let i = 0; i < m; i++) {
      let sum = 0;
      mt += '<tr><td><b>' + esc(sn(i)) + '</b></td>';
      for (let j = 0; j < n; j++) {
        const v = res.x[i * n + j]; sum += v;
        mt += '<td class="n">' + (v > 1e-9 ? '<b>' + F(v) + '</b>' : '<span style="color:var(--muted)">·</span>') + '</td>';
      }
      mt += '<td class="n">' + F(sum) + '</td></tr>';
    }
    mt += '<tr><td><b>收到合計</b></td>';
    for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += res.x[i * n + j]; mt += '<td class="n">' + F(s) + '</td>'; }
    mt += '<td></td></tr></tbody></table></div>';
    return h + mt;
  }
  function transportAnalysisHTML(model, res) {
    const m = T.m, n = T.n;
    const sn = function (i) { return T.rowNames[i].trim() || 'S' + (i + 1); };
    const dn = function (j) { return T.colNames[j].trim() || 'D' + (j + 1); };
    let h = '<h2>結果分析</h2>';
    const sRows = [], notes = [];
    for (let i = 0; i < m; i++) {
      const r = res.rows[i], rem = r.slack;
      sRows.push([esc(sn(i)), F(r.rhs), F(r.lhs), '<b>' + F(rem) + '</b>', r.binding ? badgeBind : badgeNon]);
      notes.push(rem > 1e-9 ? '供給地 ' + sn(i) + ' 尚餘 ' + F(rem) + ' 單位供應量（供給限制為 Nonbinding）。' : '供給地 ' + sn(i) + ' 的供應量已全數運出（供給限制為 Binding Constraint）。');
    }
    h += '<h3 style="margin-top:0">各供給地剩餘供應量</h3>' + table(['供給地', '供應量', '運出量', '剩餘供應量', '供給限制狀態'], sRows, ['', 'n', 'n', 'n', '']);
    const dRows = [];
    for (let j = 0; j < n; j++) {
      const r = res.rows[m + j], over = r.slack;
      dRows.push([esc(dn(j)), F(r.rhs), F(r.lhs), over > 1e-9 ? '是（多出 ' + F(over) + '）' : '是（剛好滿足）', r.binding ? badgeBind : badgeNon]);
      notes.push('需求地 ' + dn(j) + ' 的需求限制為 ' + (r.binding ? 'Binding Constraint（需求剛好被滿足）。' : 'Nonbinding（收到的量超過需求 ' + F(over) + '）。'));
    }
    h += '<h3>各需求地需求是否滿足</h3>' + table(['需求地', '需求量', '收到量', '需求是否滿足', '需求限制狀態'], dRows, ['', 'n', 'n', '', '']);
    h += '<div class="meaning"><b>管理意涵</b><ul>' + notes.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    // 影子價格說明
    if (res.hasSensitivity) {
      const best = [];
      for (let j = 0; j < n; j++) { const r = res.rows[m + j]; if (r.dual !== null && Math.abs(r.dual) > 1e-9) best.push({ nm: dn(j), d: r.dual }); }
      if (best.length) {
        best.sort(function (a, b) { return b.d - a.d; });
        h += '<p>需求影子價格最高的是「' + esc(best[0].nm) + '」：每多運送 1 單位到該需求地，總運輸成本約增加 ' + F(best[0].d) + '。（若總供給等於總需求，供給限制之間存在退化現象，影子價格可有多組等價解，請以需求端為主要參考。）</p>';
      }
    }
    return h + '</div>';
  }

  (function wireTransport() {
    const render = wireMatrix('#tab-transport', '#t-form', T, T_CFG, updateBalance);
    function load(ex) {
      T.rowNames = ex.rowNames.slice(); T.colNames = ex.colNames.slice();
      T.cost = ex.cost.map(function (r) { return r.slice(); });
      T.supply = ex.supply.slice(); T.demand = ex.demand.slice();
      T.m = T.rowNames.length; T.n = T.colNames.length;
      $('#t-m').value = T.m; $('#t-n').value = T.n;
      render(); $('#t-model-card').hidden = true; $('#t-result').innerHTML = '';
    }
    function resize() {
      resizeMatrix(T, sizeOf($('#t-m').value, T.m), sizeOf($('#t-n').value, T.n), T_CFG);
      $('#t-m').value = T.m; $('#t-n').value = T.n; render(); $('#t-model-card').hidden = true;
      restoreFocus();
    }
    $('#t-m').addEventListener('change', resize);
    $('#t-n').addEventListener('change', resize);
    $('#t-example').addEventListener('click', function () { load(T_EXAMPLE); });
    $('#t-build').addEventListener('click', function () {
      const r = buildTransportModel();
      if (r.errs) { $('#t-result').innerHTML = '<div class="banner err">' + r.errs.map(esc).join('<br>') + '</div>'; return; }
      $('#t-result').innerHTML = '';
      showTransportModel(r.model);
      $('#t-model-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#t-solve').addEventListener('click', async function () {
      const r = buildTransportModel();
      if (r.errs) { $('#t-result').innerHTML = '<div class="banner err">' + r.errs.map(esc).join('<br>') + '</div>'; return; }
      showTransportModel(r.model);
      const snapshot = JSON.parse(JSON.stringify(T));
      await runSolveWith(this, $('#t-result'), r.model, function (res) {
        // 使用求解當下的資料快照（避免之後修改輸入造成顯示不一致）
        const keep = {}; Object.keys(T).forEach(function (k) { keep[k] = T[k]; });
        Object.keys(snapshot).forEach(function (k) { T[k] = snapshot[k]; });
        const o = { solutionHTML: res.status === 'optimal' ? transportSolutionHTML(r.model, res) : null, analysisHTML: res.status === 'optimal' ? transportAnalysisHTML(r.model, res) : null };
        Object.keys(keep).forEach(function (k) { T[k] = keep[k]; });
        return o;
      });
    });
    load(T_EXAMPLE);
  })();

  // 與 runSolve 相同，但結果顯示選項由求解結果決定
  async function runSolveWith(btn, box, model, makeOpts) {
    btn.disabled = true;
    box.innerHTML = '<div class="loading">求解中…</div>';
    try {
      const highs = await getHighs();
      await new Promise(function (r) { setTimeout(r, 20); });
      const res = L.solveModel(model, highs);
      renderResults(box, model, res, makeOpts(res));
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return res;
    } catch (e) {
      box.innerHTML = '<div class="banner err">' + esc(e.message || String(e)) + '</div>';
      return null;
    } finally { btn.disabled = false; }
  }

  /* ================= 指派問題 ================= */
  const A = { m: 4, n: 4, rowNames: [], colNames: [], cost: [] };
  const A_CFG = { caps: false, rowPrefix: '人員', colPrefix: '工作', costTitle: '成本（效益）', rowWord: '人員', colWord: '工作' };
  const A_EXAMPLE = {
    rowNames: ['甲', '乙', '丙', '丁'], colNames: ['工作1', '工作2', '工作3', '工作4'],
    cost: [['9', '2', '7', '8'], ['6', '4', '3', '7'], ['5', '8', '1', '8'], ['7', '6', '9', '4']]
  };
  function aSense() { return ($('input[name=a-sense]:checked') || {}).value || 'min'; }
  function buildAssignModel() {
    const cost = matrixNums(A, '#a-form');
    if (cost.some(function (r) { return r.some(isNaN); })) return { errs: ['成本（效益）矩陣有空白或無法辨識的格子（已標紅），請填入每一格。'] };
    return { model: L.buildAssignment({ cost: cost, rowNames: A.rowNames.map(function (s) { return s.trim(); }), colNames: A.colNames.map(function (s) { return s.trim(); }), sense: aSense() }) };
  }
  function assignSolutionHTML(model, res, snap) {
    const m = snap.m, n = snap.n, cost = snap.cost.map(function (r) { return r.map(function (s) { return coef(s); }); });
    const rn = function (i) { return snap.rowNames[i].trim() || '人員' + (i + 1); };
    const cn = function (j) { return snap.colNames[j].trim() || '工作' + (j + 1); };
    const rows = [], assignedR = {}, assignedC = {};
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
      if (res.x[i * n + j] > 0.5) { rows.push([esc(rn(i)), esc(cn(j)), F(cost[i][j])]); assignedR[i] = 1; assignedC[j] = 1; }
    }
    let h = '<h3 style="margin-top:0">最佳指派方案</h3>' + table(['人員', '指派工作', model.sense === 'max' ? '效益' : '成本'], rows, ['', '', 'n']);
    h += '<div class="bigz"><span class="lbl">' + (model.sense === 'max' ? '最大總效益' : '最小總成本') + ' Z*</span><span class="z">' + F(res.z) + '</span></div>';
    const notes = [];
    for (let i = 0; i < m; i++) if (!assignedR[i]) notes.push('人員 ' + rn(i) + ' 未被指派工作。');
    for (let j = 0; j < n; j++) if (!assignedC[j]) notes.push('工作 ' + cn(j) + ' 沒有被指派人員。');
    if (notes.length) h += '<div class="meaning"><ul>' + notes.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>';
    // 指派矩陣
    h += '<h3>指派矩陣（✔ 表示指派）</h3><div class="scroll"><table class="data"><thead><tr><th></th>';
    for (let j = 0; j < n; j++) h += '<th class="n">' + esc(cn(j)) + '</th>';
    h += '</tr></thead><tbody>';
    for (let i = 0; i < m; i++) {
      h += '<tr><td><b>' + esc(rn(i)) + '</b></td>';
      for (let j = 0; j < n; j++) h += '<td class="n">' + (res.x[i * n + j] > 0.5 ? '<b style="color:var(--accent)">✔ ' + F(cost[i][j]) + '</b>' : F(cost[i][j])) + '</td>';
      h += '</tr>';
    }
    return h + '</tbody></table></div>';
  }

  (function wireAssign() {
    const render = wireMatrix('#tab-assign', '#a-form', A, A_CFG, function () {});
    function load(ex) {
      A.rowNames = ex.rowNames.slice(); A.colNames = ex.colNames.slice();
      A.cost = ex.cost.map(function (r) { return r.slice(); });
      A.m = A.rowNames.length; A.n = A.colNames.length;
      $('#a-m').value = A.m; $('#a-n').value = A.n;
      render(); $('#a-model-card').hidden = true; $('#a-result').innerHTML = '';
    }
    function resize() {
      resizeMatrix(A, sizeOf($('#a-m').value, A.m), sizeOf($('#a-n').value, A.n), A_CFG);
      $('#a-m').value = A.m; $('#a-n').value = A.n; render(); $('#a-model-card').hidden = true;
      restoreFocus();
    }
    $('#a-m').addEventListener('change', resize);
    $('#a-n').addEventListener('change', resize);
    $('#a-example').addEventListener('click', function () { load(A_EXAMPLE); });
    $$('input[name=a-sense]').forEach(function (r) { r.addEventListener('change', function () { $('#a-model-card').hidden = true; }); });
    $('#a-build').addEventListener('click', function () {
      const r = buildAssignModel();
      if (r.errs) { $('#a-result').innerHTML = '<div class="banner err">' + r.errs.map(esc).join('<br>') + '</div>'; return; }
      $('#a-result').innerHTML = '';
      $('#a-model-card').hidden = false; $('#a-model-card').style.opacity = ''; $('#a-model').textContent = L.modelText(r.model);
      $('#a-model-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    $('#a-solve').addEventListener('click', async function () {
      const r = buildAssignModel();
      if (r.errs) { $('#a-result').innerHTML = '<div class="banner err">' + r.errs.map(esc).join('<br>') + '</div>'; return; }
      $('#a-model-card').hidden = false; $('#a-model-card').style.opacity = ''; $('#a-model').textContent = L.modelText(r.model);
      const snap = JSON.parse(JSON.stringify(A));
      await runSolveWith(this, $('#a-result'), r.model, function (res) {
        return { solutionHTML: res.status === 'optimal' ? assignSolutionHTML(r.model, res, snap) : null };
      });
    });
    load(A_EXAMPLE);
  })();

  /* ================= 分頁 ================= */
  $$('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      $$('.tab').forEach(function (t) { const on = t === tab; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
      $$('.panel').forEach(function (p) { const on = p.id === 'tab-' + tab.dataset.tab; p.hidden = !on; p.classList.toggle('active', on); });
      if (lastGraph && lastGraph.cv.isConnected && lastGraph.cv.clientWidth > 0) window.LPGraph.drawGraph(lastGraph.cv, lastGraph.model, lastGraph.res);
      window.scrollTo({ top: 0 });
    });
  });

  /* ================= 結果過期提醒、Enter 鍵求解 ================= */
  watchStale('#tab-general', '#g-result');
  watchStale('#tab-transport', '#t-result', ['#t-model-card']);
  watchStale('#tab-assign', '#a-result', ['#a-model-card']);

  const SIZE_INPUTS = { 'g-n': 1, 't-m': 1, 't-n': 1, 'a-m': 1, 'a-n': 1 };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;   // 輸入法選字時的 Enter 不處理
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.type === 'checkbox' || t.type === 'radio') return;
    const panel = t.closest('.panel');
    const btn = panel && $('.btn.primary', panel);
    if (!btn) return;
    e.preventDefault();
    if (SIZE_INPUTS[t.id]) { t.blur(); return; }        // 數量欄：Enter 只是套用數量
    btn.click();
  });

  /* ================= 初始化 ================= */
  setG(EXAMPLES.hw);
  renderAllG();
})();
