/*
 * graph.js
 * 兩個決策變數時的圖形化分析：限制式直線、可行區域、最佳解、等利潤線（等成本線）
 */
(function (root) {
  'use strict';
  const PALETTE = ['#2a6fdb', '#d9531e', '#1f9d6a', '#8e44ad', '#b8860b', '#d6336c', '#0b7285', '#6c757d'];

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function clipHalf(poly, a1, a2, b) {
    const out = [];
    const eps = 1e-9;
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const fp = a1 * P[0] + a2 * P[1] - b, fq = a1 * Q[0] + a2 * Q[1] - b;
      const pin = fp <= eps, qin = fq <= eps;
      if (pin) out.push(P);
      if (pin !== qin) {
        const t = fp / (fp - fq);
        out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]);
      }
    }
    return out;
  }

  function feasible(model, x, y) {
    const tol = 1e-7;
    if (model.nonneg[0] && x < -tol) return false;
    if (model.nonneg[1] && y < -tol) return false;
    return model.cons.every(function (k) {
      const v = k.a[0] * x + k.a[1] * y;
      if (k.sign === '<=') return v <= k.rhs + tol * (1 + Math.abs(k.rhs));
      if (k.sign === '>=') return v >= k.rhs - tol * (1 + Math.abs(k.rhs));
      return Math.abs(v - k.rhs) <= tol * (1 + Math.abs(k.rhs));
    });
  }

  function lineViewSegment(a1, a2, b, v) {
    const pts = [];
    function add(x, y) {
      if (x < v.x0 - 1e-9 || x > v.x1 + 1e-9 || y < v.y0 - 1e-9 || y > v.y1 + 1e-9) return;
      for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < 1e-9 && Math.abs(pts[i][1] - y) < 1e-9) return;
      pts.push([x, y]);
    }
    if (Math.abs(a2) > 1e-12) { add(v.x0, (b - a1 * v.x0) / a2); add(v.x1, (b - a1 * v.x1) / a2); }
    if (Math.abs(a1) > 1e-12) { add((b - a2 * v.y0) / a1, v.y0); add((b - a2 * v.y1) / a1, v.y1); }
    return pts.length >= 2 ? [pts[0], pts[1]] : null;
  }

  function computeView(model, res) {
    const lines = model.cons.map(function (k) { return { a1: k.a[0], a2: k.a[1], b: k.rhs }; });
    if (model.nonneg[0]) lines.push({ a1: 1, a2: 0, b: 0 });
    if (model.nonneg[1]) lines.push({ a1: 0, a2: 1, b: 0 });
    const pts = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const L1 = lines[i], L2 = lines[j];
      const det = L1.a1 * L2.a2 - L2.a1 * L1.a2;
      if (Math.abs(det) < 1e-12) continue;
      const x = (L1.b * L2.a2 - L2.b * L1.a2) / det;
      const y = (L1.a1 * L2.b - L2.a1 * L1.b) / det;
      if (feasible(model, x, y)) pts.push([x, y]);
    }
    if (res && res.status === 'optimal') pts.push([res.x[0], res.x[1]]);
    let xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    if (!pts.length) {
      // 無可行點：用各直線的截距決定視窗
      lines.forEach(function (L) {
        if (Math.abs(L.a1) > 1e-12) xs.push(L.b / L.a1);
        if (Math.abs(L.a2) > 1e-12) ys.push(L.b / L.a2);
      });
    }
    xs.push(0); ys.push(0);
    let xmax = Math.max.apply(null, xs), xmin = Math.min.apply(null, xs);
    let ymax = Math.max.apply(null, ys), ymin = Math.min.apply(null, ys);
    function span(lo, hi, nonneg) {
      let top = hi > 0 ? hi * 1.35 : 0, bot = lo < 0 ? lo * 1.35 : 0;
      if (top - bot < 1e-9) top = 10;
      if (top - bot < 4) top = bot + 4;
      if (nonneg) bot = -(top - bot) * 0.05;
      else if (bot === 0) bot = -(top - bot) * 0.15;
      return [bot, top];
    }
    const sx = span(xmin, xmax, model.nonneg[0]), sy = span(ymin, ymax, model.nonneg[1]);
    return { x0: sx[0], x1: sx[1], y0: sy[0], y1: sy[1] };
  }

  function drawGraph(canvas, model, res) {
    const cs = getComputedStyle(canvas);
    const css = function (n, d) { const v = cs.getPropertyValue(n).trim(); return v || d; };
    const ink = css('--ink', '#1d2430'), muted = css('--muted', '#667085'), grid = css('--grid', '#e4e8ee');
    const bg = css('--surface', '#ffffff'), accent = css('--accent', '#2a6fdb');

    const cssW = canvas.clientWidth || 640, cssH = Math.round(cssW * 0.72);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cssW, cssH);

    const v = computeView(model, res);
    // 依 Y 軸刻度文字的寬度決定左邊界，避免數字很大時與軸標籤重疊
    ctx.font = '12px system-ui, "Noto Sans TC", sans-serif';
    let maxTickW = 0;
    const syPre = niceStep((v.y1 - v.y0) / 6);
    for (let y = Math.ceil(v.y0 / syPre) * syPre; y <= v.y1 + 1e-9; y += syPre) {
      maxTickW = Math.max(maxTickW, ctx.measureText(String(parseFloat(y.toPrecision(6)))).width);
    }
    const m = { l: Math.max(52, Math.ceil(maxTickW) + 36), r: 18, t: 16, b: 44 };
    const pw = cssW - m.l - m.r, ph = cssH - m.t - m.b;
    const X = function (x) { return m.l + (x - v.x0) / (v.x1 - v.x0) * pw; };
    const Y = function (y) { return m.t + (1 - (y - v.y0) / (v.y1 - v.y0)) * ph; };
    const legend = [];

    // 格線與刻度
    ctx.font = '12px system-ui, "Noto Sans TC", sans-serif';
    ctx.textBaseline = 'middle';
    const sx = niceStep((v.x1 - v.x0) / 7), sy = niceStep((v.y1 - v.y0) / 6);
    ctx.lineWidth = 1;
    for (let x = Math.ceil(v.x0 / sx) * sx; x <= v.x1 + 1e-9; x += sx) {
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(X(x), m.t); ctx.lineTo(X(x), m.t + ph); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.fillText(String(parseFloat(x.toPrecision(6))), X(x), m.t + ph + 14);
    }
    for (let y = Math.ceil(v.y0 / sy) * sy; y <= v.y1 + 1e-9; y += sy) {
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(m.l, Y(y)); ctx.lineTo(m.l + pw, Y(y)); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.fillText(String(parseFloat(y.toPrecision(6))), m.l - 6, Y(y));
    }
    // 座標軸
    ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
    if (v.y0 <= 0 && v.y1 >= 0) { ctx.beginPath(); ctx.moveTo(m.l, Y(0)); ctx.lineTo(m.l + pw, Y(0)); ctx.stroke(); }
    if (v.x0 <= 0 && v.x1 >= 0) { ctx.beginPath(); ctx.moveTo(X(0), m.t); ctx.lineTo(X(0), m.t + ph); ctx.stroke(); }
    ctx.fillStyle = ink; ctx.textAlign = 'center';
    ctx.fillText(model.disp[0], m.l + pw / 2, cssH - 10);
    ctx.save(); ctx.translate(14, m.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(model.disp[1], 0, 0); ctx.restore();

    // 可行區域
    let poly = [[v.x0, v.y0], [v.x1, v.y0], [v.x1, v.y1], [v.x0, v.y1]];
    if (model.nonneg[0]) poly = clipHalf(poly, -1, 0, 0);
    if (model.nonneg[1]) poly = clipHalf(poly, 0, -1, 0);
    model.cons.forEach(function (k) {
      if (!poly.length) return;
      if (k.sign === '<=' || k.sign === '=') poly = clipHalf(poly, k.a[0], k.a[1], k.rhs);
      if (!poly.length) return;
      if (k.sign === '>=' || k.sign === '=') poly = clipHalf(poly, -k.a[0], -k.a[1], -k.rhs);
    });
    ctx.save();
    ctx.beginPath(); ctx.rect(m.l, m.t, pw, ph); ctx.clip();
    if (poly.length >= 2) {
      ctx.beginPath();
      poly.forEach(function (p, i) { if (i) ctx.lineTo(X(p[0]), Y(p[1])); else ctx.moveTo(X(p[0]), Y(p[1])); });
      ctx.closePath();
      ctx.globalAlpha = 0.18; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
      legend.push({ color: accent, text: '可行區域 (Feasible Region)', type: 'area' });
    } else {
      legend.push({ color: muted, text: '無可行區域（Infeasible）', type: 'area' });
    }

    // 限制式直線
    model.cons.forEach(function (k, i) {
      const col = PALETTE[i % PALETTE.length];
      const seg = lineViewSegment(k.a[0], k.a[1], k.rhs, v);
      if (seg) {
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(X(seg[0][0]), Y(seg[0][1])); ctx.lineTo(X(seg[1][0]), Y(seg[1][1])); ctx.stroke();
      }
      legend.push({ color: col, text: (k.name ? k.name + '：' : '') + root.LPCore.conExpr(model, i), type: 'line' });
    });

    // 整數格點
    const allInt = model.vtype.every(function (t) { return t !== 'C'; });
    if (allInt && (v.x1 - v.x0) <= 40 && (v.y1 - v.y0) <= 40) {
      ctx.fillStyle = muted;
      for (let xi = Math.ceil(v.x0); xi <= v.x1; xi++) for (let yi = Math.ceil(v.y0); yi <= v.y1; yi++) {
        if (feasible(model, xi, yi)) { ctx.beginPath(); ctx.arc(X(xi), Y(yi), 2.5, 0, 7); ctx.fill(); }
      }
      legend.push({ color: muted, text: '可行的整數點', type: 'dot' });
    }

    // 等利潤線／等成本線與最佳解
    const isMax = model.sense === 'max';
    if (res && res.status === 'optimal') {
      const c1 = model.c[0], c2 = model.c[1];
      const name = isMax ? '等利潤線' : '等成本線';
      if (Math.abs(c1) > 1e-12 || Math.abs(c2) > 1e-12) {
        const factors = Math.abs(res.z) < 1e-9 ? [1] : (isMax ? [0.5, 0.75, 1] : [1.5, 1.25, 1]);
        factors.forEach(function (f) {
          const seg = lineViewSegment(c1, c2, res.z * f, v);
          if (!seg) return;
          ctx.strokeStyle = ink; ctx.lineWidth = f === 1 ? 2.5 : 1.2;
          ctx.setLineDash(f === 1 ? [8, 5] : [3, 4]);
          ctx.beginPath(); ctx.moveTo(X(seg[0][0]), Y(seg[0][1])); ctx.lineTo(X(seg[1][0]), Y(seg[1][1])); ctx.stroke();
        });
        ctx.setLineDash([]);
        legend.push({ color: ink, text: name + '（虛線；通過最佳解者 Z* = ' + root.LPCore.fmt(res.z) + '）', type: 'dash' });
      }
      const px = X(res.x[0]), py = Y(res.x[1]);
      ctx.fillStyle = '#e03131'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, 7, 0, 7); ctx.fill(); ctx.stroke();
      legend.push({ color: '#e03131', text: '最佳解 (' + root.LPCore.fmt(res.x[0]) + ', ' + root.LPCore.fmt(res.x[1]) + ')', type: 'dot' });
      ctx.restore();
      // 最佳解標籤（在裁切區外繪製以免被截斷）
      const label = '最佳解 (' + root.LPCore.fmt(res.x[0]) + ', ' + root.LPCore.fmt(res.x[1]) + ')';
      ctx.font = '600 12px system-ui, "Noto Sans TC", sans-serif';
      const tw = ctx.measureText(label).width;
      let lx = px + 12, ly = py - 14;
      if (lx + tw > m.l + pw) lx = px - 12 - tw;
      if (ly < m.t + 8) ly = py + 16;
      ctx.fillStyle = bg; ctx.globalAlpha = 0.85; ctx.fillRect(lx - 3, ly - 9, tw + 6, 18); ctx.globalAlpha = 1;
      ctx.fillStyle = '#e03131'; ctx.textAlign = 'left'; ctx.fillText(label, lx, ly);
    } else {
      ctx.restore();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.strokeRect(m.l, m.t, pw, ph);
    return legend;
  }

  root.LPGraph = { drawGraph: drawGraph };
})(typeof self !== 'undefined' ? self : this);
