// SPDX-License-Identifier: LGPL-2.1-only
// Copyright (C) 2026 benerone
// This file is part of remotephotoserver; see the LICENSE file for the terms.

'use strict';

// Image editor: pencil, crop, perspective (keystone) crop.
// The working image is a <canvas> at the photo's resolution; a second canvas
// on top draws the handles and receives the gestures.
const Editor = (() => {
  const MAX_PIXELS = 16e6;   // canvas area limit on mobile (iOS)
  const UNDO_BUDGET = 48e6;  // total pixels kept for undo
  const COLORS = [['#e53935', 'Red'], ['#fdd835', 'Yellow'], ['#43a047', 'Green'], ['#1e88e5', 'Blue'], ['#111111', 'Black']];
  const SIZES = [0.0025, 0.005, 0.009, 0.015, 0.025]; // stroke width, as a fraction of the longer side
  const MAX_ZOOM = 8;
  const HIT = 28;            // handle grab radius, in screen pixels
  const HINTS = {
    crop: 'Drag the edges or the corners',
    persp: 'Place the 4 corners on those of the sheet',
  };

  const root = $('editor'), stage = $('ed-stage'), overlay = $('ed-overlay');
  const octx = overlay.getContext('2d');
  let work = null, wctx = null, view = null, opts = null;
  let tool = 'draw', color = COLORS[0][0], sizeIdx = 1;
  let undoStack = [], undoLost = false, dirty = false;
  let crop = null, quad = null, drag = null;
  // Zoom: 1 shows the whole image; pan is the offset from the centred position.
  let zoom = 1, panX = 0, panY = 0, lastW = 0, lastH = 0;
  const pointers = new Map(); // active pointers, in stage coordinates
  let pinch = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const area = c => c.width * c.height;

  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // ---- Working image and history ----

  function setWork(c) {
    if (work) work.remove();
    work = c;
    c.className = 'work';
    stage.insertBefore(c, overlay);
    wctx = c.getContext('2d');
    if (c.width !== lastW || c.height !== lastH) { // new geometry: show it all
      zoom = 1; panX = panY = 0;
      lastW = c.width; lastH = c.height;
    }
    resetShapes();
    layout();
  }

  function resetShapes() {
    const W = work.width, H = work.height, m = 0.1;
    crop = { x0: 0, y0: 0, x1: W, y1: H };
    quad = [{ x: W * m, y: H * m }, { x: W * (1 - m), y: H * m }, { x: W * (1 - m), y: H * (1 - m) }, { x: W * m, y: H * (1 - m) }];
  }

  function remember(c) {
    undoStack.push(c);
    let total = undoStack.reduce((n, u) => n + area(u), 0);
    while (undoStack.length > 1 && total > UNDO_BUDGET) {
      const old = undoStack.shift();
      total -= area(old);
      old.width = 0; // free the memory right away
      undoLost = true;
    }
    dirty = true;
    $('ed-undo').disabled = false;
  }

  // Before a stroke we keep a copy; before a crop, the old canvas itself.
  function snapshot() {
    const c = newCanvas(work.width, work.height);
    c.getContext('2d').drawImage(work, 0, 0);
    remember(c);
  }
  function replaceWork(c) {
    const old = work;
    old.remove();
    work = null;
    remember(old);
    setWork(c);
  }

  function undo() {
    const c = undoStack.pop();
    if (!c) return;
    work.width = 0;
    setWork(c);
    dirty = undoStack.length > 0 || undoLost;
    $('ed-undo').disabled = !undoStack.length;
  }

  // ---- Layout and coordinate conversions ----

  function layout() {
    const r = stage.getBoundingClientRect();
    if (!work || !r.width || !r.height) return;
    const pad = 22;
    const fit = Math.min((r.width - 2 * pad) / work.width, (r.height - 2 * pad) / work.height);
    const s = fit * zoom, iw = work.width * s, ih = work.height * s;
    // The image may be panned only as far as its edges (plus the margin).
    const maxX = Math.max(0, (iw - r.width) / 2 + pad), maxY = Math.max(0, (ih - r.height) / 2 + pad);
    panX = clamp(panX, -maxX, maxX);
    panY = clamp(panY, -maxY, maxY);
    view = { s, fit, x: (r.width - iw) / 2 + panX, y: (r.height - ih) / 2 + panY, w: r.width, h: r.height };
    Object.assign(work.style, { left: view.x + 'px', top: view.y + 'px', width: iw + 'px', height: ih + 'px' });
    $('ed-zoom-reset').textContent = Math.round(zoom * 100) + ' %';
    $('ed-zoom-out').disabled = zoom <= 1;
    $('ed-zoom-in').disabled = zoom >= MAX_ZOOM;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(r.width * dpr);
    overlay.height = Math.round(r.height * dpr);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function stagePoint(e) {
    const r = overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function toImg(e) {
    const p = stagePoint(e);
    return { x: (p.x - view.x) / view.s, y: (p.y - view.y) / view.s };
  }
  const toScr = p => ({ x: view.x + p.x * view.s, y: view.y + p.y * view.s });

  // Sets the zoom while keeping image point (ix, iy) under stage point (sx, sy).
  function setZoom(z, sx, sy, ix, iy) {
    zoom = clamp(z, 1, MAX_ZOOM);
    const s = view.fit * zoom;
    panX = sx - ix * s - (view.w - work.width * s) / 2;
    panY = sy - iy * s - (view.h - work.height * s) / 2;
    layout();
  }
  function zoomBy(factor, sx = view.w / 2, sy = view.h / 2) {
    if (!work || !view) return;
    setZoom(zoom * factor, sx, sy, (sx - view.x) / view.s, (sy - view.y) / view.s);
  }

  // Two fingers: pinch to zoom, move to pan.
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  function startPinch() {
    const m = pinchState();
    pinch = { d0: m.d, z0: zoom, ix: (m.x - view.x) / view.s, iy: (m.y - view.y) / view.s };
  }

  // ---- Overlay drawing (handles, loupe) ----

  function draw() {
    if (!view) return;
    octx.clearRect(0, 0, view.w, view.h);
    if (tool === 'crop') drawCrop();
    if (tool === 'persp') drawQuad();
    if (drag && drag.loupe) drawLoupe(drag.loupe);
  }

  function drawCrop() {
    const a = toScr({ x: crop.x0, y: crop.y0 }), b = toScr({ x: crop.x1, y: crop.y1 });
    const w = b.x - a.x, hh = b.y - a.y;
    octx.fillStyle = 'rgba(0,0,0,.6)';
    octx.beginPath();
    octx.rect(0, 0, view.w, view.h);
    octx.rect(a.x, a.y, w, hh);
    octx.fill('evenodd');
    octx.strokeStyle = 'rgba(255,255,255,.35)';
    octx.lineWidth = 1;
    octx.beginPath();
    for (const t of [1 / 3, 2 / 3]) {
      octx.moveTo(a.x + w * t, a.y); octx.lineTo(a.x + w * t, b.y);
      octx.moveTo(a.x, a.y + hh * t); octx.lineTo(b.x, a.y + hh * t);
    }
    octx.stroke();
    octx.strokeStyle = '#fff';
    octx.lineWidth = 2;
    octx.strokeRect(a.x, a.y, w, hh);
    octx.fillStyle = '#fff';
    octx.strokeStyle = '#000';
    octx.lineWidth = 1;
    for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
      if (fx === 0.5 && fy === 0.5) continue;
      const x = a.x + w * fx, y = a.y + hh * fy;
      octx.beginPath();
      octx.rect(x - 7, y - 7, 14, 14);
      octx.fill(); octx.stroke();
    }
  }

  function drawQuad() {
    const pts = quad.map(toScr);
    const path = () => {
      octx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) octx.lineTo(pts[i].x, pts[i].y);
      octx.closePath();
    };
    octx.fillStyle = 'rgba(0,0,0,.55)';
    octx.beginPath();
    octx.rect(0, 0, view.w, view.h);
    path();
    octx.fill('evenodd');
    octx.strokeStyle = '#4c9aff';
    octx.lineWidth = 2;
    octx.beginPath(); path(); octx.stroke();
    for (const p of pts) {
      octx.beginPath();
      octx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      octx.fillStyle = 'rgba(76,154,255,.35)';
      octx.fill();
      octx.strokeStyle = '#fff';
      octx.stroke();
    }
  }

  // Loupe: the finger hides the corner being moved.
  function drawLoupe(p) {
    const s = toScr(p), R = 54, z = Math.max(view.s * 3, 1);
    let cy = s.y - R - 44;
    if (cy - R < 4) cy = s.y + R + 44;
    const cx = clamp(s.x, R + 4, view.w - R - 4);
    const half = R / z;
    const sx0 = Math.max(0, p.x - half), sy0 = Math.max(0, p.y - half);
    const sx1 = Math.min(work.width, p.x + half), sy1 = Math.min(work.height, p.y + half);
    octx.save();
    octx.beginPath();
    octx.arc(cx, cy, R, 0, Math.PI * 2);
    octx.clip();
    octx.fillStyle = '#000';
    octx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    if (sx1 > sx0 && sy1 > sy0) {
      octx.drawImage(work, sx0, sy0, sx1 - sx0, sy1 - sy0,
        cx + (sx0 - p.x) * z, cy + (sy0 - p.y) * z, (sx1 - sx0) * z, (sy1 - sy0) * z);
    }
    octx.restore();
    octx.strokeStyle = '#fff';
    octx.lineWidth = 2;
    octx.beginPath();
    octx.arc(cx, cy, R, 0, Math.PI * 2);
    octx.moveTo(cx - 10, cy); octx.lineTo(cx + 10, cy);
    octx.moveTo(cx, cy - 10); octx.lineTo(cx, cy + 10);
    octx.stroke();
  }

  // ---- Gestures ----

  function strokeWidth() {
    return Math.max(1.5, SIZES[sizeIdx] * Math.max(work.width, work.height));
  }

  function hitCrop(e) {
    const p = stagePoint(e);
    const a = toScr({ x: crop.x0, y: crop.y0 }), b = toScr({ x: crop.x1, y: crop.y1 });
    const dl = Math.abs(p.x - a.x), dr = Math.abs(p.x - b.x), dt = Math.abs(p.y - a.y), db = Math.abs(p.y - b.y);
    const inY = p.y >= a.y - HIT && p.y <= b.y + HIT, inX = p.x >= a.x - HIT && p.x <= b.x + HIT;
    const hit = {
      l: inY && dl <= HIT && dl <= dr, r: inY && dr <= HIT && dr < dl,
      t: inX && dt <= HIT && dt <= db, b: inX && db <= HIT && db < dt,
    };
    if (hit.l || hit.r || hit.t || hit.b) return hit;
    if (p.x > a.x && p.x < b.x && p.y > a.y && p.y < b.y) return { move: true };
    return null;
  }

  function hitQuad(e) {
    const p = stagePoint(e);
    let best = -1, bestD = HIT * 1.8;
    quad.forEach((q, i) => {
      const s = toScr(q), d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // A second finger landing turns the gesture into a pinch: the stroke the
  // first finger had started is removed.
  function cancelDrag() {
    if (drag && drag.kind === 'draw') {
      const c = undoStack.pop();
      wctx.clearRect(0, 0, work.width, work.height);
      wctx.drawImage(c, 0, 0);
      c.width = 0;
      dirty = undoStack.length > 0 || undoLost;
      $('ed-undo').disabled = !undoStack.length;
    }
    drag = null;
  }

  function onDown(e) {
    if (!work || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointers.set(e.pointerId, stagePoint(e));
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (pointers.size === 2) {
      cancelDrag();
      startPinch();
      draw();
      return;
    }
    if (pointers.size > 2 || drag) return;
    const p = toImg(e);
    if (tool === 'draw') {
      snapshot();
      wctx.fillStyle = color;
      wctx.beginPath();
      wctx.arc(p.x, p.y, strokeWidth() / 2, 0, Math.PI * 2);
      wctx.fill();
      drag = { kind: 'draw', last: p };
    } else if (tool === 'crop') {
      const hit = hitCrop(e);
      if (!hit) return;
      drag = { kind: 'crop', hit, start: p, orig: { ...crop } };
    } else {
      const i = hitQuad(e);
      if (i < 0) return;
      drag = { kind: 'quad', i, dx: quad[i].x - p.x, dy: quad[i].y - p.y, loupe: quad[i] };
    }
    drag.id = e.pointerId;
    draw();
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, stagePoint(e));
    if (pinch) {
      if (pointers.size >= 2) {
        const m = pinchState();
        setZoom(pinch.z0 * m.d / pinch.d0, m.x, m.y, pinch.ix, pinch.iy);
      }
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const W = work.width, H = work.height;
    if (drag.kind === 'draw') {
      const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      wctx.strokeStyle = color;
      wctx.lineWidth = strokeWidth();
      wctx.lineCap = wctx.lineJoin = 'round';
      wctx.beginPath();
      wctx.moveTo(drag.last.x, drag.last.y);
      for (const ev of events.length ? events : [e]) {
        drag.last = toImg(ev);
        wctx.lineTo(drag.last.x, drag.last.y);
      }
      wctx.stroke();
      return;
    }
    const p = toImg(e);
    if (drag.kind === 'crop') {
      const o = drag.orig, hit = drag.hit, dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      const min = Math.min(16, W, H);
      if (hit.move) {
        const w = o.x1 - o.x0, hh = o.y1 - o.y0;
        crop.x0 = clamp(o.x0 + dx, 0, W - w); crop.x1 = crop.x0 + w;
        crop.y0 = clamp(o.y0 + dy, 0, H - hh); crop.y1 = crop.y0 + hh;
      } else {
        if (hit.l) crop.x0 = clamp(o.x0 + dx, 0, crop.x1 - min);
        if (hit.r) crop.x1 = clamp(o.x1 + dx, crop.x0 + min, W);
        if (hit.t) crop.y0 = clamp(o.y0 + dy, 0, crop.y1 - min);
        if (hit.b) crop.y1 = clamp(o.y1 + dy, crop.y0 + min, H);
        drag.loupe = {
          x: hit.l ? crop.x0 : hit.r ? crop.x1 : clamp(p.x, crop.x0, crop.x1),
          y: hit.t ? crop.y0 : hit.b ? crop.y1 : clamp(p.y, crop.y0, crop.y1),
        };
      }
    } else {
      const q = quad[drag.i];
      q.x = clamp(p.x + drag.dx, 0, W);
      q.y = clamp(p.y + drag.dy, 0, H);
    }
    draw();
  }

  function onUp(e) {
    if (!pointers.delete(e.pointerId)) return;
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    draw();
  }

  function onWheel(e) {
    e.preventDefault();
    const p = stagePoint(e);
    // Trackpad pinches arrive as ctrl+wheel with small deltas.
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
  }

  // ---- Operations ----

  function applyCrop() {
    const x0 = Math.round(crop.x0), y0 = Math.round(crop.y0);
    const w = Math.round(crop.x1) - x0, hh = Math.round(crop.y1) - y0;
    if (w === work.width && hh === work.height) {
      toast(t('Move the edges of the frame first'));
      return;
    }
    const c = newCanvas(w, hh);
    c.getContext('2d').drawImage(work, -x0, -y0);
    replaceWork(c);
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1) return false;
      if (sign && Math.sign(cross) !== sign) return false;
      sign = Math.sign(cross);
    }
    return true;
  }

  // Rectifies quad q (TL, TR, BR, BL) into a rectangle: unit square -> quad
  // homography (Heckbert), then bilinear sampling.
  function warp(q) {
    const W = work.width, H = work.height;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let hh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * hh)));
    w = Math.max(1, Math.round(w * k)); hh = Math.max(1, Math.round(hh * k));

    const [p0, p1, p2, p3] = q;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, sx = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, sy = p0.y - p1.y + p2.y - p3.y;
    const den = dx1 * dy2 - dx2 * dy1;
    const g = (sx * dy2 - dx2 * sy) / den, hp = (dx1 * sy - sx * dy1) / den;
    const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hp * p3.x, c = p0.x;
    const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hp * p3.y, f = p0.y;

    const src = wctx.getImageData(0, 0, W, H).data;
    const out = new ImageData(w, hh);
    const dst = out.data;
    const ax = a / w, dxs = d / w, gx = g / w;
    let o = 0;
    for (let j = 0; j < hh; j++) {
      const v = (j + 0.5) / hh;
      let nx = b * v + c + ax * 0.5, ny = e * v + f + dxs * 0.5, dn = hp * v + 1 + gx * 0.5;
      for (let i = 0; i < w; i++) {
        let x = nx / dn - 0.5, y = ny / dn - 0.5;
        x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
        y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const r0 = (y0 * W + x0) * 4, r1 = r0 + (y0 < H - 1 ? W * 4 : 0), step = x0 < W - 1 ? 4 : 0;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        dst[o] = src[r0] * w00 + src[r0 + step] * w10 + src[r1] * w01 + src[r1 + step] * w11;
        dst[o + 1] = src[r0 + 1] * w00 + src[r0 + step + 1] * w10 + src[r1 + 1] * w01 + src[r1 + step + 1] * w11;
        dst[o + 2] = src[r0 + 2] * w00 + src[r0 + step + 2] * w10 + src[r1 + 2] * w01 + src[r1 + step + 2] * w11;
        dst[o + 3] = src[r0 + 3] * w00 + src[r0 + step + 3] * w10 + src[r1 + 3] * w01 + src[r1 + step + 3] * w11;
        o += 4;
        nx += ax; ny += dxs; dn += gx;
      }
    }
    const cv = newCanvas(w, hh);
    cv.getContext('2d').putImageData(out, 0, 0);
    return cv;
  }

  async function applyPersp() {
    if (!isConvex(quad)) {
      toast(t('The 4 corners must form a convex quadrilateral, in order'), true);
      return;
    }
    busy(t('Straightening…'));
    await new Promise(r => setTimeout(r, 30)); // let the message paint first
    try {
      replaceWork(warp(quad));
    } catch (err) {
      toast(t('Straightening failed: {0}', err.message), true);
    } finally {
      busy('');
    }
  }

  function setTool(name) {
    tool = name;
    for (const b of $('ed-tools').children) b.classList.toggle('on', b.dataset.tool === name);
    $('ed-draw-opts').hidden = name !== 'draw';
    $('ed-apply-opts').hidden = name === 'draw';
    $('ed-hint').textContent = HINTS[name] ? t(HINTS[name]) : '';
    overlay.style.cursor = name === 'draw' ? 'crosshair' : 'default';
    layout(); // the toolbar height may change
  }

  // ---- Saving ----

  function exportBlob(asPNG, mayHaveAlpha) {
    let src = work;
    if (!asPNG && mayHaveAlpha) { // JPEG has no transparency: white background
      src = newCanvas(work.width, work.height);
      const ctx = src.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.drawImage(work, 0, 0);
    }
    return new Promise(res => src.toBlob(res, asPNG ? 'image/png' : 'image/jpeg', 0.92));
  }

  async function save(asNew) {
    const [stem, ext] = splitName(opts.name);
    const low = ext.toLowerCase();
    const isJPEG = low === '.jpg' || low === '.jpeg';
    const outExt = low === '.png' || isJPEG ? ext : '.jpg';
    let name = opts.name, overwrite = false;
    if (asNew) {
      const s = await askName(t('Save as a new image'), freeStem(opts.names(), stem + '-edit', outExt), outExt);
      if (!s) return;
      name = s + outExt;
    } else if (!dirty) {
      toast(t('No change to save'));
      return;
    } else if (outExt === ext) {
      overwrite = true;
    } else { // GIF, WebP: saved as JPEG next to the original
      name = freeStem(opts.names(), stem, outExt) + outExt;
    }
    busy(t('Saving…'));
    try {
      const blob = await exportBlob(low === '.png', !isJPEG);
      if (!blob) throw new Error(t('The image could not be exported'));
      const res = await api('img/' + encodeURIComponent(name) + (overwrite ? '?overwrite=1' : ''), { method: 'PUT', body: blob });
      dirty = false;
      toast(t('Saved: {0}', res.name));
      await opts.onSaved(res.name);
    } catch (err) {
      toast(err.message, true);
    } finally {
      busy('');
    }
  }

  // ---- Open, close ----

  async function open(o) {
    busy(t('Loading…'));
    try {
      const img = new Image();
      // onload rather than decode(): decode() can stall while the page is in the background.
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('image load failed'));
        img.src = o.url;
      });
      let w = img.naturalWidth, hh = img.naturalHeight;
      const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * hh)));
      w = Math.max(1, Math.round(w * k)); hh = Math.max(1, Math.round(hh * k));
      const c = newCanvas(w, hh);
      c.getContext('2d').drawImage(img, 0, 0, w, hh);
      opts = o;
      undoStack = []; undoLost = false; dirty = false; drag = null;
      pointers.clear(); pinch = null; lastW = lastH = 0;
      $('ed-undo').disabled = true;
      root.hidden = false;
      setWork(c);
      setTool('draw');
    } finally {
      busy('');
    }
  }

  function close() {
    root.hidden = true;
    for (const c of undoStack) c.width = 0;
    undoStack = [];
    if (work) { work.remove(); work.width = 0; work = null; }
    opts = null; drag = null; pinch = null;
    pointers.clear();
  }

  // ---- Setup ----

  COLORS.forEach(([c, label], i) => {
    $('ed-colors').append(h('button', {
      class: 'swatch' + (i === 0 ? ' on' : ''), style: `background:${c}`, title: t(label), 'aria-label': t(label),
      onclick: e => {
        color = c;
        for (const b of $('ed-colors').children) b.classList.toggle('on', b === e.currentTarget);
        $('ed-sizes').style.color = c === '#111111' ? '#ddd' : c;
      },
    }));
  });
  SIZES.forEach((_, i) => {
    const d = [5, 9, 13, 18, 24][i];
    $('ed-sizes').append(h('button', {
      class: 'size' + (i === sizeIdx ? ' on' : ''), title: t('Size {0}', i + 1), 'aria-label': t('Size {0}', i + 1),
      onclick: e => {
        sizeIdx = i;
        for (const b of $('ed-sizes').children) b.classList.toggle('on', b === e.currentTarget);
      },
    }, h('i', { style: `width:${d}px;height:${d}px;margin:auto` })));
  });
  $('ed-sizes').style.color = color;

  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  overlay.addEventListener('pointerup', onUp);
  overlay.addEventListener('pointercancel', onUp);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  $('ed-zoom-in').addEventListener('click', () => zoomBy(1.5));
  $('ed-zoom-out').addEventListener('click', () => zoomBy(1 / 1.5));
  $('ed-zoom-reset').addEventListener('click', () => { zoom = 1; panX = panY = 0; layout(); });
  for (const b of $('ed-tools').children) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('ed-undo').addEventListener('click', undo);
  $('ed-reset').addEventListener('click', () => { resetShapes(); draw(); });
  $('ed-apply').addEventListener('click', () => (tool === 'crop' ? applyCrop() : applyPersp()));
  $('ed-save').addEventListener('click', () => save(false));
  $('ed-saveas').addEventListener('click', () => save(true));
  new ResizeObserver(layout).observe(stage);

  return {
    open, close,
    isOpen: () => !root.hidden,
    canClose: () => !dirty || confirm(t('Discard unsaved changes?')),
  };
})();
