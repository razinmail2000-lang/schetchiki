/* PaddleOCR PP-OCRv4 (детектор строк + распознавание) на ONNX Runtime Web (WASM).
   Модели: lib/paddle/*.onnx (Apache-2.0, PaddlePaddle), движок: lib/ort (MIT, Microsoft).
   API: PaddleOCR.load(base, progress) → PaddleOCR.read(canvas, {detect}) → {text, lines:[{text,score,box}]} */
(function () {
  'use strict';
  const P = { det: null, rec: null, keys: null, loading: null, base: '' };

  async function fetchBuf(url, progress, label) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(label + ': HTTP ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    if (!r.body || !total || !progress) return new Uint8Array(await r.arrayBuffer());
    const rd = r.body.getReader(), parts = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; progress(label, got / total); }
    const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function load(base, progress) {
    if (P.rec) return Promise.resolve(P);
    if (P.loading) return P.loading;
    P.base = base;
    P.loading = (async () => {
      const ort = window.ort;
      if (!ort) throw new Error('onnxruntime не загружен');
      ort.env.wasm.wasmPaths = base + 'lib/ort/';
      ort.env.wasm.numThreads = 1; // без cross-origin isolation потоки недоступны
      ort.env.wasm.proxy = false;
      const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const keysTxt = await (await fetch(base + 'lib/paddle/ppocr_keys_v1.txt')).text();
      P.keys = keysTxt.split(/\r?\n/).filter((s, i, a) => !(i === a.length - 1 && s === ''));
      const recBuf = await fetchBuf(base + 'lib/paddle/ch_PP-OCRv4_rec_infer.onnx', progress, 'распознавание');
      P.rec = await ort.InferenceSession.create(recBuf, opt);
      const detBuf = await fetchBuf(base + 'lib/paddle/ch_PP-OCRv4_det_infer.onnx', progress, 'поиск строк');
      P.det = await ort.InferenceSession.create(detBuf, opt);
      return P;
    })();
    P.loading.catch(() => { P.loading = null; });
    return P.loading;
  }

  function canvasOf(src, w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    return [c, g];
  }

  /* ---- распознавание одной строки ---- */
  const REC_H = 48;
  async function recLine(src, sx, sy, sw, sh) {
    const ort = window.ort;
    let W = Math.max(16, Math.round(REC_H * sw / sh));
    W = Math.min(W, 1280);
    const Wp = Math.max(W, 80);
    const [c, g] = canvasOf(src, Wp, REC_H);
    g.fillStyle = '#7f7f7f'; g.fillRect(0, 0, Wp, REC_H);
    g.drawImage(src, sx, sy, sw, sh, 0, 0, W, REC_H);
    const d = g.getImageData(0, 0, Wp, REC_H).data, n = Wp * REC_H;
    const t = new Float32Array(3 * n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { // BGR, (x/255-0.5)/0.5
      t[i] = d[j + 2] / 127.5 - 1; t[n + i] = d[j + 1] / 127.5 - 1; t[2 * n + i] = d[j] / 127.5 - 1;
    }
    const feeds = {}; feeds[P.rec.inputNames[0]] = new ort.Tensor('float32', t, [1, 3, REC_H, Wp]);
    const out = (await P.rec.run(feeds))[P.rec.outputNames[0]];
    const [, T, C] = out.dims, p = out.data;
    let text = '', last = 0, sum = 0, cnt = 0;
    for (let k = 0; k < T; k++) {
      let bi = 0, bv = -1; const o = k * C;
      for (let q = 0; q < C; q++) if (p[o + q] > bv) { bv = p[o + q]; bi = q; }
      if (bi !== 0 && bi !== last) { text += bi - 1 < P.keys.length ? P.keys[bi - 1] : ' '; sum += bv; cnt++; }
      last = bi;
    }
    return { text, score: cnt ? sum / cnt : 0 };
  }

  /* ---- поиск строк текста (DB) ---- */
  async function detect(src, W0, H0, maxSide) {
    const ort = window.ort;
    const k = Math.min(1, maxSide / Math.max(W0, H0));
    const W = Math.max(32, Math.round(W0 * k / 32) * 32), H = Math.max(32, Math.round(H0 * k / 32) * 32);
    const [c, g] = canvasOf(src, W, H);
    g.drawImage(src, 0, 0, W0, H0, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data, n = W * H;
    const t = new Float32Array(3 * n), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0, j = 0; i < n; i++, j += 4) { // BGR как в PaddleOCR
      t[i] = (d[j + 2] / 255 - mean[0]) / std[0]; t[n + i] = (d[j + 1] / 255 - mean[1]) / std[1]; t[2 * n + i] = (d[j] / 255 - mean[2]) / std[2];
    }
    const feeds = {}; feeds[P.det.inputNames[0]] = new ort.Tensor('float32', t, [1, 3, H, W]);
    const out = (await P.det.run(feeds))[P.det.outputNames[0]];
    const prob = out.data, mw = out.dims[3], mh = out.dims[2];
    // связные области на бинарной карте
    const TH = 0.3, BOX_TH = 0.55, lab = new Int32Array(mw * mh), boxes = [];
    const stack = [];
    for (let s = 0; s < mw * mh; s++) {
      if (prob[s] <= TH || lab[s]) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, area = 0, psum = 0;
      stack.push(s); lab[s] = 1;
      while (stack.length) {
        const q = stack.pop(), x = q % mw, y = (q / mw) | 0;
        area++; psum += prob[q];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        const nb = [q - 1, q + 1, q - mw, q + mw];
        if (x === 0) nb[0] = -1; if (x === mw - 1) nb[1] = -1;
        for (const r of nb) if (r >= 0 && r < mw * mh && !lab[r] && prob[r] > TH) { lab[r] = 1; stack.push(r); }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bh < 3 || bw < 3 || psum / area < BOX_TH) continue;
      // «разжатие» рамки (unclip 1.6): DB-карта уже текста
      const off = (bw * bh) * 1.6 / (2 * (bw + bh));
      const sx = W0 / mw, sy = H0 / mh;
      boxes.push({
        x: Math.max(0, (x0 - off) * sx), y: Math.max(0, (y0 - off) * sy),
        w: Math.min(W0, (x1 + 1 + off) * sx) - Math.max(0, (x0 - off) * sx),
        h: Math.min(H0, (y1 + 1 + off) * sy) - Math.max(0, (y0 - off) * sy),
      });
    }
    boxes.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
    return boxes;
  }

  /* opts.detect: искать строки (для целого фото и рамки); false — вся картинка одна строка */
  async function read(src, opts = {}) {
    const W0 = src.width, H0 = src.height;
    const lines = [];
    if (opts.detect !== false) {
      const boxes = await detect(src, W0, H0, opts.maxSide || 960);
      for (const b of boxes.slice(0, opts.maxLines || 30)) {
        if (b.h < 6 || b.w < 8) continue;
        const r = await recLine(src, b.x, b.y, b.w, b.h);
        if (r.text) lines.push(Object.assign(r, { box: b }));
      }
    }
    if (!lines.length) { const r = await recLine(src, 0, 0, W0, H0); if (r.text) lines.push(Object.assign(r, { box: { x: 0, y: 0, w: W0, h: H0 } })); }
    return { text: lines.map(l => l.text).join('\n'), lines };
  }

  window.PaddleOCR = { load, read, recLine, detect, get ready() { return !!P.rec; } };
})();
