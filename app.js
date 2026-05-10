/* Plotly — a tiny, dependency-free 2D layout-map editor.
   Coordinate system: world units = meters. Rendering scales by `pxPerMeter` * zoom. */

(() => {
  'use strict';

  // ---------- State ----------
  const state = {
    objects: [],        // all shapes in z-order
    selectedId: null,
    tool: 'select',
    nextId: 1,
    view: { x: 0, y: 0, zoom: 1 }, // pan in screen px, zoom multiplier
    pxPerMeter: 40,
    pxPerBox: 50,        // screen pixels per grid box (drives pxPerMeter)
    grid: { show: true, snap: true, size: 0.3048 }, // 1 ft default
    showDims: true,
    units: 'ft', // 'm' = meters, 'ft' = feet & inches
    defaultWallThickness: 0.1524, // 6" in meters
    projectName: 'Untitled Layout',
    history: [],
    future: [],
  };

  const M_PER_FT = 0.3048;

  const STORAGE_KEY = 'plotly.layout.v1';

  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('hint');
  const status = document.getElementById('status');
  const propsEmpty = document.getElementById('props-empty');
  const propsForm = document.getElementById('props-form');
  const layerList = document.getElementById('layer-list');

  const propEls = {
    label: document.getElementById('prop-label'),
    x: document.getElementById('prop-x'),
    y: document.getElementById('prop-y'),
    w: document.getElementById('prop-w'),
    h: document.getElementById('prop-h'),
    fill: document.getElementById('prop-fill'),
    stroke: document.getElementById('prop-stroke'),
    strokew: document.getElementById('prop-strokew'),
    thickness: document.getElementById('prop-thickness'),
    openingW: document.getElementById('prop-opening-w'),
    rotation: document.getElementById('prop-rotation'),
  };
  const propThicknessRow = document.getElementById('prop-thickness-row');
  const propOpeningRow = document.getElementById('prop-opening-row');
  const propOpeningWLabel = document.getElementById('prop-opening-w-label');

  // ---------- Helpers ----------
  const uid = () => state.nextId++;

  const screenToWorld = (sx, sy) => {
    const s = state.pxPerMeter * state.view.zoom;
    return { x: (sx - state.view.x) / s, y: (sy - state.view.y) / s };
  };
  const worldToScreen = (wx, wy) => {
    const s = state.pxPerMeter * state.view.zoom;
    return { x: wx * s + state.view.x, y: wy * s + state.view.y };
  };

  const snap = (v) => {
    if (!state.grid.snap) return v;
    const g = state.grid.size;
    return Math.round(v / g) * g;
  };

  const fmt = (n) => (Math.round(n * 100) / 100).toString();

  // Unit conversion + formatting
  const mToFt = (m) => m / M_PER_FT;
  const ftToM = (f) => f * M_PER_FT;

  // Format meters according to current unit choice.
  // Meters: "3.25 m". Feet/inches: `12'-3"` (rounded to nearest 1/2 inch by default)
  function fmtLen(meters) {
    if (state.units === 'ft') return fmtFeetInches(meters);
    return `${fmt(meters)} m`;
  }

  function fmtFeetInches(meters) {
    const totalInches = mToFt(meters) * 12;
    // Round to nearest 1/2 inch for display
    const half = Math.round(totalInches * 2) / 2;
    let ft = Math.trunc(half / 12);
    let inches = half - ft * 12;
    if (inches < 0) { inches += 12; ft -= 1; }
    // Roll over: e.g. 11.99" -> 12" -> +1 ft
    if (inches >= 12) { ft += 1; inches -= 12; }
    const inStr = (inches % 1 === 0) ? `${inches}"` : `${inches.toFixed(1)}"`;
    return `${ft}'-${inStr}`;
  }

  // Format meters as a value suitable for an editable input field.
  // Meters: numeric like "3.25". Feet/inches: a string like `12'-3"`.
  function fmtLenInput(meters) {
    if (state.units === 'ft') return fmtFeetInches(meters);
    return fmt(meters);
  }

  // Parse a length string into meters. Accepts:
  //   - bare number: meters or feet depending on current units
  //   - `12'`, `12'3"`, `12'-3"`, `12 ft 3 in`, `3 in`, `36"`
  //   - `1.5m`, `150cm`, `1500mm`
  function parseLen(str) {
    if (str == null) return null;
    const s = String(str).trim().toLowerCase();
    if (s === '') return null;

    // Explicit metric suffix
    let m = s.match(/^(-?\d*\.?\d+)\s*(mm|cm|m)$/);
    if (m) {
      const v = parseFloat(m[1]);
      if (m[2] === 'mm') return v / 1000;
      if (m[2] === 'cm') return v / 100;
      return v;
    }

    // Feet / inches forms
    // e.g. 12'3", 12'-3", 12', 3", 12ft 3in, 12 ft 3 in, 12 feet 3 inches
    const ftInRe = /^(?:(-?\d*\.?\d+)\s*(?:'|ft|feet|foot))?\s*[-\s]?\s*(?:(-?\d*\.?\d+)\s*(?:"|in|inch|inches))?$/;
    const fi = s.match(ftInRe);
    if (fi && (fi[1] || fi[2])) {
      const ft = parseFloat(fi[1] || '0') || 0;
      const inches = parseFloat(fi[2] || '0') || 0;
      return ftToM(ft + inches / 12);
    }

    // Bare number: interpret per current units
    const num = parseFloat(s);
    if (!isNaN(num)) {
      return state.units === 'ft' ? ftToM(num) : num;
    }
    return null;
  }

  function pushHistory() {
    state.history.push(JSON.stringify({ objects: state.objects, nextId: state.nextId }));
    if (state.history.length > 100) state.history.shift();
    state.future.length = 0;
  }
  function undo() {
    if (state.history.length === 0) return;
    state.future.push(JSON.stringify({ objects: state.objects, nextId: state.nextId }));
    const snap = JSON.parse(state.history.pop());
    state.objects = snap.objects;
    state.nextId = snap.nextId;
    state.selectedId = null;
    refreshAll();
  }
  function redo() {
    if (state.future.length === 0) return;
    state.history.push(JSON.stringify({ objects: state.objects, nextId: state.nextId }));
    const snap = JSON.parse(state.future.pop());
    state.objects = snap.objects;
    state.nextId = snap.nextId;
    state.selectedId = null;
    refreshAll();
  }

  // ---------- Object factories ----------
  function makeObject(type, props) {
    const base = {
      id: uid(),
      type,
      label: '',
      fill: '#e8f0ff',
      stroke: '#1f3a8a',
      strokeWidth: 2,
    };
    return Object.assign(base, props);
  }

  // Object types:
  // - room:   {x, y, w, h}
  // - wall:   {x1, y1, x2, y2, thickness}
  // - door:   {x, y, w, rot}
  // - window: {x, y, w, rot}
  // - text:   {x, y, text, size}

  function getBounds(o) {
    switch (o.type) {
      case 'room':
        return { x: o.x, y: o.y, w: o.w, h: o.h };
      case 'wall':
      case 'measure': {
        const x = Math.min(o.x1, o.x2), y = Math.min(o.y1, o.y2);
        return { x, y, w: Math.abs(o.x2 - o.x1) || 0.1, h: Math.abs(o.y2 - o.y1) || 0.1 };
      }
      case 'door':
      case 'window': {
        // Rotation-aware AABB around the opening's two endpoints.
        const rad = (o.rot || 0) * Math.PI / 180;
        const ex = o.x + Math.cos(rad) * o.w;
        const ey = o.y + Math.sin(rad) * o.w;
        const x = Math.min(o.x, ex);
        const y = Math.min(o.y, ey);
        const pad = 0.1; // small padding so the halo doesn't sit on the line
        return {
          x: x - pad,
          y: y - pad,
          w: Math.max(0.1, Math.abs(ex - o.x)) + pad * 2,
          h: Math.max(0.1, Math.abs(ey - o.y)) + pad * 2,
        };
      }
      case 'text':
        return { x: o.x, y: o.y - 0.3, w: Math.max(1, o.text.length * 0.2), h: 0.4 };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  function setBounds(o, b) {
    switch (o.type) {
      case 'room':
        o.x = b.x; o.y = b.y; o.w = Math.max(0.1, b.w); o.h = Math.max(0.1, b.h); break;
      case 'wall':
      case 'measure': {
        const dx = b.x - Math.min(o.x1, o.x2);
        const dy = b.y - Math.min(o.y1, o.y2);
        o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
        break;
      }
      case 'door':
      case 'window': {
        // Translate the opening so its AABB top-left matches the requested b.x,b.y
        const cur = getBounds(o);
        const dx = b.x - cur.x;
        const dy = b.y - cur.y;
        o.x += dx; o.y += dy;
        if (typeof b.w === 'number' && b.w > 0) o.w = Math.max(0.3, b.w);
        break;
      }
      case 'text':
        o.x = b.x; o.y = b.y + 0.3; break;
    }
  }

  function hitTest(wx, wy) {
    // top-most first
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      const b = getBounds(o);
      const pad = 0.15; // meters tolerance for thin objects
      if (wx >= b.x - pad && wx <= b.x + b.w + pad &&
          wy >= b.y - pad && wy <= b.y + b.h + pad) {
        return o;
      }
    }
    return null;
  }

  // ---------- Rendering ----------
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);

    // Background paper — soft cool off-white with a faint vertical gradient
    const grad = ctx.createLinearGradient(0, 0, 0, r.height);
    grad.addColorStop(0, '#f7f8fb');
    grad.addColorStop(1, '#eef1f6');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, r.width, r.height);

    drawGrid(r);

    // Objects
    // Objects: two passes so dimension labels never get covered by other shapes
    for (const o of state.objects) drawObject(o);
    if (state.showDims) {
      for (const o of state.objects) drawObjectDimensions(o);
    }

    // Selection halo
    if (state.selectedId != null) {
      const o = state.objects.find(x => x.id === state.selectedId);
      if (o) drawSelection(o);
    }

    updateStatus();
  }

  function drawGrid(r) {
    if (!state.grid.show) return;
    const s = state.pxPerMeter * state.view.zoom;
    const step = state.grid.size * s;
    if (step < 6) return; // too dense

    const ox = state.view.x % step;
    const oy = state.view.y % step;

    ctx.strokeStyle = '#e3e7ef';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < r.width; x += step) {
      ctx.moveTo(x, 0); ctx.lineTo(x, r.height);
    }
    for (let y = oy; y < r.height; y += step) {
      ctx.moveTo(0, y); ctx.lineTo(r.width, y);
    }
    ctx.stroke();

    // Major grid every 5 cells
    const major = step * 5;
    const ox2 = state.view.x % major;
    const oy2 = state.view.y % major;
    ctx.strokeStyle = '#c7cfdd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox2; x < r.width; x += major) { ctx.moveTo(x, 0); ctx.lineTo(x, r.height); }
    for (let y = oy2; y < r.height; y += major) { ctx.moveTo(0, y); ctx.lineTo(r.width, y); }
    ctx.stroke();

    // Origin axes
    const o = worldToScreen(0, 0);
    ctx.strokeStyle = '#9aa5ba';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, r.height);
    ctx.moveTo(0, o.y); ctx.lineTo(r.width, o.y);
    ctx.stroke();
  }

  function drawObject(o) {
    const s = state.pxPerMeter * state.view.zoom;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (o.type === 'room') {
      const p = worldToScreen(o.x, o.y);
      ctx.fillStyle = o.fill;
      ctx.strokeStyle = o.stroke;
      ctx.lineWidth = o.strokeWidth;
      ctx.fillRect(p.x, p.y, o.w * s, o.h * s);
      ctx.strokeRect(p.x, p.y, o.w * s, o.h * s);

      if (o.label) {
        ctx.fillStyle = '#1c2433';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.label, p.x + (o.w * s) / 2, p.y + (o.h * s) / 2);
      }
    } else if (o.type === 'wall') {
      const a = worldToScreen(o.x1, o.y1);
      const b = worldToScreen(o.x2, o.y2);
      ctx.strokeStyle = o.stroke || '#1f2937';
      ctx.lineWidth = (o.thickness || state.defaultWallThickness) * s;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (o.type === 'door') {
      const p = worldToScreen(o.x, o.y);
      const w = o.w * s;
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      ctx.strokeStyle = o.stroke || '#874f0e';
      ctx.lineWidth = 2;
      // Opening line (single)
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(w, 0);
      ctx.stroke();
      // Door swing arc
      ctx.beginPath();
      ctx.arc(0, 0, w, 0, -Math.PI / 2, true);
      ctx.stroke();
      // Door panel
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, -w);
      ctx.stroke();
    } else if (o.type === 'window') {
      const p = worldToScreen(o.x, o.y);
      const w = o.w * s;
      ctx.translate(p.x, p.y);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      ctx.fillStyle = '#cfe6ff';
      ctx.strokeStyle = o.stroke || '#1f3a8a';
      ctx.lineWidth = 2;
      ctx.fillRect(0, -4, w, 8);
      ctx.strokeRect(0, -4, w, 8);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.stroke();
    } else if (o.type === 'text') {
      const p = worldToScreen(o.x, o.y);
      ctx.fillStyle = o.fill || '#1c2433';
      ctx.font = `${(o.size || 14)}px system-ui, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(o.text || 'Text', p.x, p.y);
    } else if (o.type === 'measure') {
      const a = worldToScreen(o.x1, o.y1);
      const b = worldToScreen(o.x2, o.y2);
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      ctx.strokeStyle = '#d61f3f';
      ctx.fillStyle = '#d61f3f';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(fmtLen(len), (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6);
    }

    ctx.restore();
  }

  // Second pass — draw dimension labels for an object so they sit above all
  // body fills/strokes and never get hidden by overlapping rooms.
  function drawObjectDimensions(o) {
    const s = state.pxPerMeter * state.view.zoom;
    if (o.type === 'room') {
      drawDimension(o.x, o.y - 0.2, o.x + o.w, o.y - 0.2, fmtLen(o.w));
      drawDimension(o.x - 0.2, o.y, o.x - 0.2, o.y + o.h, fmtLen(o.h), true);
    } else if (o.type === 'wall') {
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const t = (o.thickness || state.defaultWallThickness) * s;
      drawDimension(o.x1, o.y1, o.x2, o.y2, fmtLen(len), false, t / 2 + 12);
    } else if (o.type === 'door' || o.type === 'window') {
      // Cycle through 4 label positions around the door's right angle:
      //   0: parallel to opening, side A (default)
      //   1: parallel to panel,   side A
      //   2: parallel to opening, side B
      //   3: parallel to panel,   side B
      const w = o.w;
      const rotDeg = o.rot || 0;
      const side = doorDimSide(o);
      const armRotDeg = (side === 0 || side === 2) ? rotDeg : rotDeg - 90;
      const perpSign = (side === 0 || side === 1) ? 1 : -1;
      const rad = armRotDeg * Math.PI / 180;
      const ex = o.x + Math.cos(rad) * w;
      const ey = o.y + Math.sin(rad) * w;
      o._dimLabel = drawDimension(o.x, o.y, ex, ey, fmtLen(w), false, 14 * perpSign);
    }
  }

  // Normalize door/window dimSide to 0..3, mapping legacy +1/-1 values.
  function doorDimSide(o) {
    const raw = o.dimSide;
    if (raw === undefined || raw === null) return 0;
    if (raw === 1) return 0;
    if (raw === -1) return 2;
    return ((Math.round(raw) % 4) + 4) % 4;
  }

  function drawDimension(x1, y1, x2, y2, label, vertical = false, perpOffset = 0) {
    const a = worldToScreen(x1, y1);
    const b = worldToScreen(x2, y2);
    ctx.save();
    ctx.strokeStyle = '#5b6478';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // tick marks
    const tick = 5;
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(a.x - tick, a.y); ctx.lineTo(a.x + tick, a.y);
      ctx.moveTo(b.x - tick, b.y); ctx.lineTo(b.x + tick, b.y);
    } else {
      ctx.moveTo(a.x, a.y - tick); ctx.lineTo(a.x, a.y + tick);
      ctx.moveTo(b.x, b.y - tick); ctx.lineTo(b.x, b.y + tick);
    }
    ctx.stroke();

    // Label with background pill, rotated for vertical/diagonal lines
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) { ctx.restore(); return null; } // too short to label clearly

    let angle = Math.atan2(dy, dx);
    // Keep text upright (avoid upside-down)
    let flipped = false;
    if (angle > Math.PI / 2)  { angle -= Math.PI; flipped = true; }
    if (angle < -Math.PI / 2) { angle += Math.PI; flipped = true; }

    let cx = (a.x + b.x) / 2;
    let cy = (a.y + b.y) / 2;

    // Perpendicular offset (in screen px) — useful for thick walls.
    // The sign of perpOffset controls which side of the line the label sits on.
    if (perpOffset) {
      const nx = -dy / len, ny = dx / len; // unit normal
      const sign = flipped ? -1 : 1;
      cx += nx * perpOffset * sign;
      cy += ny * perpOffset * sign;
    }

    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width;
    const padX = 5, padY = 2, h = 14;
    // Pill background
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#c8cdd6';
    ctx.lineWidth = 1;
    roundRect(ctx, -w / 2 - padX, -h / 2 - padY, w + padX * 2, h + padY * 2, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1c2433';
    ctx.fillText(label, 0, 0);
    ctx.restore();

    // Return the label's screen-space bounding box (in its rotated frame)
    // so callers can hit-test clicks on it.
    return { cx, cy, angle, halfW: w / 2 + padX, halfH: h / 2 + padY };
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function drawSelection(o) {
    const b = getBounds(o);
    const p = worldToScreen(b.x, b.y);
    const s = state.pxPerMeter * state.view.zoom;
    ctx.save();
    const color = o.locked ? '#9aa5ba' : '#5b8cff';
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 3, p.y - 3, b.w * s + 6, b.h * s + 6);
    ctx.setLineDash([]);
    if (!o.locked) {
      // resize handles only when editable
      ctx.fillStyle = color;
      const handles = getHandles(o);
      for (const h of handles) {
        const sp = worldToScreen(h.x, h.y);
        ctx.fillRect(sp.x - 4, sp.y - 4, 8, 8);
      }
    } else {
      // small lock badge in the top-left corner of the selection
      ctx.fillStyle = '#1c2433';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('\uD83D\uDD12', p.x - 6, p.y - 18);
    }
    ctx.restore();
  }

  function getHandles(o) {
    if (o.type === 'room') {
      return [
        { id: 'nw', x: o.x,         y: o.y },
        { id: 'ne', x: o.x + o.w,   y: o.y },
        { id: 'sw', x: o.x,         y: o.y + o.h },
        { id: 'se', x: o.x + o.w,   y: o.y + o.h },
      ];
    }
    if (o.type === 'wall' || o.type === 'measure') {
      return [
        { id: 'p1', x: o.x1, y: o.y1 },
        { id: 'p2', x: o.x2, y: o.y2 },
      ];
    }
    if (o.type === 'door' || o.type === 'window') {
      // End handle follows rotation so it stays at the actual end of the opening.
      const rad = (o.rot || 0) * Math.PI / 180;
      return [{ id: 'end', x: o.x + Math.cos(rad) * o.w, y: o.y + Math.sin(rad) * o.w }];
    }
    return [];
  }

  function hitHandle(o, wx, wy) {
    const tol = 8 / (state.pxPerMeter * state.view.zoom);
    for (const h of getHandles(o)) {
      if (Math.abs(h.x - wx) < tol && Math.abs(h.y - wy) < tol) return h.id;
    }
    return null;
  }

  // Hit-test door/window dimension labels (rendered in the dimensions pass).
  // Returns the matched object, or null. `sx`,`sy` are screen-space px relative
  // to the canvas top-left (matches how the dim label rect was stored).
  function hitDimensionLabel(sx, sy) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'door' && o.type !== 'window') continue;
      const r = o._dimLabel;
      if (!r) continue;
      // Convert click into the rect's local rotated frame.
      const cos = Math.cos(-r.angle), sin = Math.sin(-r.angle);
      const lx = (sx - r.cx) * cos - (sy - r.cy) * sin;
      const ly = (sx - r.cx) * sin + (sy - r.cy) * cos;
      if (Math.abs(lx) <= r.halfW && Math.abs(ly) <= r.halfH) return o;
    }
    return null;
  }

  // ---------- Status / Hint ----------
  function setHint(msg) { hint.textContent = msg; }
  function updateStatus() {
    const unit = state.units === 'ft' ? 'ft' : 'm';
    const boxLabel = state.units === 'ft'
      ? `${fmt(mToFt(state.grid.size))} ft`
      : `${fmt(state.grid.size)} m`;
    status.textContent = `zoom: ${Math.round(state.view.zoom * 100)}%  |  units: ${unit}  |  box: ${boxLabel} = ${state.pxPerBox}px  |  objects: ${state.objects.length}`;
  }

  // ---------- Tools / Interaction ----------
  let drag = null;
  // drag = { mode: 'create'|'move'|'resize'|'pan', startScreen, startWorld, original, handle, tempObj }

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const sw = { x: snap(w.x), y: snap(w.y) };

    // Pan with middle mouse
    if (e.button === 1) {
      drag = { mode: 'pan', startScreen: { x: sx, y: sy }, startView: { ...state.view } };
      canvas.style.cursor = 'grabbing';
      return;
    }

    // Right-click: switch to Select / Move mode
    if (e.button === 2) {
      // Cancel any in-progress create drag and remove the partial shape
      if (drag && drag.mode === 'create' && drag.obj) {
        state.objects = state.objects.filter(o => o.id !== drag.obj.id);
      }
      drag = null;
      const btn = document.querySelector('.tool[data-tool="select"]');
      if (btn) btn.click();
      // Try to select whatever is under the cursor
      const hit = hitTest(w.x, w.y);
      state.selectedId = hit ? hit.id : null;
      refreshAll();
      return;
    }

    // Click on a door/window dimension label cycles it around the right angle.
    // Only intercept when the Select tool is active so other drawing tools work normally.
    if (state.showDims && state.tool === 'select') {
      const dimHit = hitDimensionLabel(sx, sy);
      if (dimHit && !dimHit.locked) {
        pushHistory();
        dimHit.dimSide = (doorDimSide(dimHit) + 1) % 4;
        state.selectedId = dimHit.id;
        refreshAll();
        return;
      }
    }

    if (state.tool === 'select') {
      const hit = hitTest(w.x, w.y);
      if (hit) {
        state.selectedId = hit.id;
        if (hit.locked) {
          // Selecting a locked object is allowed (so you can unlock it),
          // but no move/resize drag is started.
          drag = null;
        } else {
          const handle = hitHandle(hit, w.x, w.y);
          if (handle) {
            drag = { mode: 'resize', handle, original: JSON.parse(JSON.stringify(hit)), startWorld: w };
          } else {
            drag = { mode: 'move', original: JSON.parse(JSON.stringify(hit)), startWorld: w };
          }
        }
        refreshProps();
        refreshLayers();
        draw();
      } else {
        state.selectedId = null;
        drag = { mode: 'pan', startScreen: { x: sx, y: sy }, startView: { ...state.view } };
        canvas.style.cursor = 'grabbing';
        refreshProps();
        refreshLayers();
        draw();
      }
      return;
    }

    // Creation tools
    pushHistory();
    let obj;
    if (state.tool === 'room') {
      obj = makeObject('room', { x: sw.x, y: sw.y, w: 0, h: 0, label: '' });
    } else if (state.tool === 'wall') {
      obj = makeObject('wall', { x1: sw.x, y1: sw.y, x2: sw.x, y2: sw.y, thickness: state.defaultWallThickness, stroke: '#1f2937' });
    } else if (state.tool === 'door') {
      obj = makeObject('door', { x: sw.x, y: sw.y, w: 0.9, rot: 0 });
      state.objects.push(obj);
      state.selectedId = obj.id;
      drag = null;
      refreshAll();
      return;
    } else if (state.tool === 'window') {
      obj = makeObject('window', { x: sw.x, y: sw.y, w: 1.2, rot: 0 });
      state.objects.push(obj);
      state.selectedId = obj.id;
      drag = null;
      refreshAll();
      return;
    } else if (state.tool === 'text') {
      const txt = prompt('Enter text:', 'Label');
      if (txt) {
        obj = makeObject('text', { x: sw.x, y: sw.y, text: txt, size: 14, fill: '#111827' });
        state.objects.push(obj);
        state.selectedId = obj.id;
      }
      drag = null;
      refreshAll();
      return;
    } else if (state.tool === 'measure') {
      // Never snap measurements to grid
      obj = makeObject('measure', { x1: w.x, y1: w.y, x2: w.x, y2: w.y });
      state.objects.push(obj);
      state.selectedId = obj.id;
      drag = { mode: 'create', startWorld: w, obj };
      return;
    }

    if (obj) {
      state.objects.push(obj);
      state.selectedId = obj.id;
      drag = { mode: 'create', startWorld: sw, obj };
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const sw = { x: snap(w.x), y: snap(w.y) };

    if (!drag) {
      return;
    }

    if (drag.mode === 'pan') {
      state.view.x = drag.startView.x + (sx - drag.startScreen.x);
      state.view.y = drag.startView.y + (sy - drag.startScreen.y);
      draw();
      return;
    }

    if (drag.mode === 'create') {
      const o = drag.obj;
      // Measure stays unsnapped so it can show precise non-whole numbers
      const useSnap = !(o.type === 'measure');
      const px = useSnap ? sw.x : w.x;
      const py = useSnap ? sw.y : w.y;
      if (o.type === 'room') {
        o.w = px - drag.startWorld.x;
        o.h = py - drag.startWorld.y;
        if (o.w < 0) { o.x = px; o.w = -o.w; }
        if (o.h < 0) { o.y = py; o.h = -o.h; }
      } else if (o.type === 'wall' || o.type === 'measure') {
        // Constrain to horizontal/vertical with Shift
        if (e.shiftKey) {
          const dx = Math.abs(px - o.x1);
          const dy = Math.abs(py - o.y1);
          if (dx > dy) { o.x2 = px; o.y2 = o.y1; }
          else { o.x2 = o.x1; o.y2 = py; }
        } else {
          o.x2 = px; o.y2 = py;
        }
      }
      draw();
      refreshProps();
      return;
    }

    if (drag.mode === 'move') {
      const o = state.objects.find(x => x.id === state.selectedId);
      if (!o) return;
      const dx = snap(w.x - drag.startWorld.x);
      const dy = snap(w.y - drag.startWorld.y);
      const orig = drag.original;
      if (o.type === 'room') { o.x = orig.x + dx; o.y = orig.y + dy; }
      else if (o.type === 'wall' || o.type === 'measure') {
        o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy;
        o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy;
      } else { o.x = orig.x + dx; o.y = orig.y + dy; }
      draw();
      refreshProps();
      return;
    }

    if (drag.mode === 'resize') {
      const o = state.objects.find(x => x.id === state.selectedId);
      if (!o) return;
      const orig = drag.original;
      if (o.type === 'room') {
        let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
        if (drag.handle.includes('w')) x1 = sw.x;
        if (drag.handle.includes('e')) x2 = sw.x;
        if (drag.handle.includes('n')) y1 = sw.y;
        if (drag.handle.includes('s')) y2 = sw.y;
        o.x = Math.min(x1, x2); o.y = Math.min(y1, y2);
        o.w = Math.max(0.1, Math.abs(x2 - x1));
        o.h = Math.max(0.1, Math.abs(y2 - y1));
      } else if (o.type === 'wall' || o.type === 'measure') {
        const useSnap = o.type !== 'measure';
        const px = useSnap ? sw.x : w.x;
        const py = useSnap ? sw.y : w.y;
        if (drag.handle === 'p1') { o.x1 = px; o.y1 = py; }
        else { o.x2 = px; o.y2 = py; }
      } else if (o.type === 'door' || o.type === 'window') {
        const dx = sw.x - orig.x;
        const dy = sw.y - orig.y;
        o.w = Math.max(0.3, Math.sqrt(dx * dx + dy * dy));
        o.rot = Math.atan2(dy, dx) * 180 / Math.PI;
      }
      draw();
      refreshProps();
      return;
    }
  });

  canvas.addEventListener('mouseup', () => {
    if (drag && drag.mode === 'create') {
      const o = drag.obj;
      // Discard zero-size shapes
      if ((o.type === 'room' && (o.w < 0.1 || o.h < 0.1)) ||
          ((o.type === 'wall' || o.type === 'measure') &&
            Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 0.1)) {
        state.objects.pop();
        state.selectedId = null;
      }
    }
    drag = null;
    canvas.style.cursor = 'default';
    refreshAll();
  });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Double-click on a door/window flips its direction (mirrors the opening
  // about its current end-point). Visually it stays in the same span but the
  // swing arc and dimension direction reverse.
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const hit = hitTest(w.x, w.y);
    if (!hit || hit.locked) return;
    if (hit.type !== 'door' && hit.type !== 'window') return;
    e.preventDefault();
    pushHistory();
    flipOpening(hit);
    state.selectedId = hit.id;
    refreshAll();
  });

  function flipOpening(o) {
    // Move the origin to the current end point, then rotate 180° so the
    // opening ends back at the original origin.
    const rad = (o.rot || 0) * Math.PI / 180;
    o.x = o.x + Math.cos(rad) * o.w;
    o.y = o.y + Math.sin(rad) * o.w;
    o.rot = ((o.rot || 0) + 180) % 360;
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.view.zoom = Math.max(0.1, Math.min(8, state.view.zoom * factor));
    const after = screenToWorld(sx, sy);
    const s = state.pxPerMeter * state.view.zoom;
    state.view.x += (after.x - before.x) * s;
    state.view.y += (after.y - before.y) * s;
    draw();
  }, { passive: false });

  // ---------- Toolbar ----------
  document.querySelectorAll('.tool').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
      const hints = {
        select: 'Click to select. Drag to move. Drag handles to resize. Scroll to zoom.',
        room: 'Click and drag to draw a room.',
        wall: 'Click and drag to draw a wall. Hold Shift for straight lines.',
        door: 'Click to drop a door. Drag the end handle to set width / angle.',
        window: 'Click to drop a window. Drag the end handle to set width / angle.',
        text: 'Click to place a text label.',
        measure: 'Click and drag to measure a distance.',
      };
      setHint(hints[state.tool] || '');
    });
  });

  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);
  document.getElementById('btn-copy').addEventListener('click', copySelected);
  document.getElementById('btn-paste').addEventListener('click', pasteClipboard);
  document.getElementById('btn-duplicate').addEventListener('click', duplicateSelected);
  document.getElementById('btn-delete').addEventListener('click', deleteSelected);

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('btn-zoom-reset').addEventListener('click', resetView);

  document.getElementById('btn-new').addEventListener('click', () => {
    if (!confirm('Start a new layout? Unsaved changes will be lost.')) return;
    state.objects = [];
    state.selectedId = null;
    state.history = [];
    state.future = [];
    state.projectName = 'Untitled Layout';
    const pn = document.getElementById('project-name');
    if (pn) pn.value = state.projectName;
    refreshAll();
  });

  // Project name input \u2014 keep state in sync; mark dirty on change so Save lights up.
  (() => {
    const pn = document.getElementById('project-name');
    if (!pn) return;
    pn.value = state.projectName;
    pn.addEventListener('input', () => {
      state.projectName = pn.value;
      scheduleAutosave();
      updateSaveButton();
    });
    // Blur normalizes blank to placeholder default
    pn.addEventListener('blur', () => {
      if (!pn.value.trim()) {
        state.projectName = 'Untitled Layout';
        pn.value = state.projectName;
        scheduleAutosave();
        updateSaveButton();
      }
    });
  })();
  document.getElementById('btn-save').addEventListener('click', () => {
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
      lastSavedSnapshot = serialize();
      updateSaveButton();
      flash('Saved to browser');
    } catch (err) {
      flash('Save failed');
    }
  });
  document.getElementById('btn-load').addEventListener('click', () => {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return flash('No saved layout');
    deserialize(data);
    flash('Loaded');
  });
  document.getElementById('btn-export-json').addEventListener('click', () => {
    download(exportFilename('json'), serialize(), 'application/json');
  });
  document.getElementById('file-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { if (deserialize(reader.result)) flash('Imported'); };
    reader.readAsText(file);
    e.target.value = '';
  });
  document.getElementById('btn-export-png').addEventListener('click', exportPNG);

  // Canvas option inputs
  document.getElementById('opt-units').addEventListener('change', (e) => {
    state.units = e.target.value === 'ft' ? 'ft' : 'm';
    refreshUnitLabels();
    refreshAll();
  });
  document.getElementById('opt-grid').addEventListener('change', (e) => { state.grid.show = e.target.checked; draw(); scheduleAutosave(); });
  document.getElementById('opt-snap').addEventListener('change', (e) => { state.grid.snap = e.target.checked; scheduleAutosave(); });
  document.getElementById('opt-dims').addEventListener('change', (e) => { state.showDims = e.target.checked; draw(); scheduleAutosave(); });
  document.getElementById('opt-grid-size').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      state.grid.size = state.units === 'ft' ? ftToM(v) : v;
      applyPxPerBox();
      draw();
      scheduleAutosave();
    }
  });
  document.getElementById('opt-box-px').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) {
      state.pxPerBox = v;
      applyPxPerBox();
      draw();
      scheduleAutosave();
    }
  });

  // Property inputs
  Object.entries(propEls).forEach(([key, el]) => {
    el.addEventListener('input', () => {
      const o = state.objects.find(x => x.id === state.selectedId);
      if (!o) return;
      const b = getBounds(o);
      switch (key) {
        case 'label': o.label = el.value; if (o.type === 'text') o.text = el.value; break;
        case 'x': { const v = parseLen(el.value); if (v != null) setBounds(o, { ...b, x: v }); break; }
        case 'y': { const v = parseLen(el.value); if (v != null) setBounds(o, { ...b, y: v }); break; }
        case 'w': { const v = parseLen(el.value); if (v != null && v > 0) setBounds(o, { ...b, w: v }); break; }
        case 'h': { const v = parseLen(el.value); if (v != null && v > 0) setBounds(o, { ...b, h: v }); break; }
        case 'fill': o.fill = el.value; break;
        case 'stroke': o.stroke = el.value; break;
        case 'strokew': o.strokeWidth = parseFloat(el.value) || 1; break;
        case 'thickness': {
          if (o.type !== 'wall') break;
          const v = parseLen(el.value);
          if (v != null && v > 0) {
            o.thickness = v;
            // Remember as default for next new wall
            state.defaultWallThickness = v;
          }
          break;
        }
        case 'openingW': {
          if (o.type !== 'door' && o.type !== 'window') break;
          const v = parseLen(el.value);
          if (v != null && v > 0) o.w = v;
          break;
        }
        case 'rotation': {
          if (o.type !== 'door' && o.type !== 'window') break;
          const v = parseFloat(el.value);
          if (!isNaN(v)) o.rot = v;
          break;
        }
      }
      draw();
      refreshLayers();
      scheduleAutosave();
    });
  });

  // Commit thickness on blur with formatted value
  propEls.thickness.addEventListener('blur', () => {
    const o = state.objects.find(x => x.id === state.selectedId);
    if (o && o.type === 'wall') propEls.thickness.value = fmtLenInput(o.thickness || state.defaultWallThickness);
  });

  function refreshUnitLabels() {
    const u = state.units === 'ft' ? 'ft\'in"' : 'm';
    document.querySelectorAll('[data-axis]').forEach(span => {
      const a = span.dataset.axis;
      const names = { x: 'X', y: 'Y', w: 'Width', h: 'Height' };
      span.textContent = `${names[a]} (${u})`;
    });
    document.getElementById('opt-grid-size-label').textContent =
      state.units === 'ft' ? 'Box size (ft per grid)' : 'Box size (m per grid)';
    populateGridSizeOptions();
    // Refresh selected wall's thickness display in current units
    const sel = state.objects.find(x => x.id === state.selectedId);
    if (sel && sel.type === 'wall' && propEls.thickness) {
      propEls.thickness.value = fmtLenInput(sel.thickness || state.defaultWallThickness);
    }
  }

  // Build the Box-size dropdown options based on current units, and select
  // the option closest to the current grid.size.
  function populateGridSizeOptions() {
    const sel = document.getElementById('opt-grid-size');
    if (!sel) return;
    const opts = state.units === 'ft'
      ? [
          { v: 0.5, label: '6"' },
          { v: 1,   label: '1\'' },
          { v: 2,   label: '2\'' },
          { v: 5,   label: '5\'' },
          { v: 10,  label: '10\'' },
        ]
      : [
          { v: 0.1, label: '10 cm' },
          { v: 0.25, label: '25 cm' },
          { v: 0.5, label: '50 cm' },
          { v: 1,   label: '1 m' },
          { v: 2,   label: '2 m' },
          { v: 5,   label: '5 m' },
        ];
    sel.innerHTML = '';
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = String(o.v);
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    // Pick option whose value (in current units) is closest to current grid.size (meters)
    const currentInUnits = state.units === 'ft' ? mToFt(state.grid.size) : state.grid.size;
    let best = opts[0], bestDiff = Infinity;
    for (const o of opts) {
      const d = Math.abs(o.v - currentInUnits);
      if (d < bestDiff) { best = o; bestDiff = d; }
    }
    sel.value = String(best.v);
    // Snap stored grid size to the chosen option (so dimensions/snapping match)
    state.grid.size = state.units === 'ft' ? ftToM(best.v) : best.v;
    applyPxPerBox();
  }

  // Keep one grid box rendered at exactly state.pxPerBox screen pixels by
  // deriving pxPerMeter from the grid size.
  function applyPxPerBox() {
    if (!state.pxPerBox || state.grid.size <= 0) return;
    state.pxPerMeter = state.pxPerBox / state.grid.size;
  }

  // Keyboard
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 's') { e.preventDefault(); document.getElementById('btn-save').click(); return; }
      if (k === 'n') { e.preventDefault(); document.getElementById('btn-new').click(); return; }
      if (k === 'c') { e.preventDefault(); copySelected(); return; }
      if (k === 'x') { e.preventDefault(); cutSelected(); return; }
      if (k === 'v') { e.preventDefault(); pasteClipboard(); return; }
      if (k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    }
    const map = { v: 'select', r: 'room', w: 'wall', d: 'door', n: 'window', t: 'text', m: 'measure' };
    if (map[e.key.toLowerCase()]) {
      const tool = map[e.key.toLowerCase()];
      const btn = document.querySelector(`.tool[data-tool="${tool}"]`);
      if (btn) btn.click();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelected();
    } else if (e.key === '+' || e.key === '=') { zoomBy(1.2); }
    else if (e.key === '-') { zoomBy(1 / 1.2); }
    else if (e.key === '0') { resetView(); }
  });

  function deleteSelected() {
    if (state.selectedId == null) return;
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) return;
    if (o.locked) { flash('Object is locked'); return; }
    pushHistory();
    state.objects = state.objects.filter(x => x.id !== state.selectedId);
    state.selectedId = null;
    refreshAll();
  }

  // ---------- Clipboard (in-memory) ----------
  let clipboard = null;        // deep-cloned object (without id)
  let pasteCount = 0;          // for cascading paste offsets

  function copySelected() {
    if (state.selectedId == null) return;
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) return;
    clipboard = JSON.parse(JSON.stringify(o));
    delete clipboard.id;
    delete clipboard.locked; // pasted copies start unlocked
    delete clipboard._dimLabel;
    pasteCount = 0;
    flash('Copied');
  }

  function cutSelected() {
    if (state.selectedId == null) return;
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) return;
    if (o.locked) { flash('Object is locked'); return; }
    clipboard = JSON.parse(JSON.stringify(o));
    delete clipboard.id;
    delete clipboard.locked;
    delete clipboard._dimLabel;
    pasteCount = 0;
    pushHistory();
    state.objects = state.objects.filter(x => x.id !== o.id);
    state.selectedId = null;
    refreshAll();
    flash('Cut');
  }

  function pasteClipboard() {
    if (!clipboard) { flash('Clipboard is empty'); return; }
    pushHistory();
    pasteCount += 1;
    // Offset by one grid box per paste so the copy doesn't sit exactly on top
    const off = state.grid.size * pasteCount;
    const copy = JSON.parse(JSON.stringify(clipboard));
    copy.id = uid();
    offsetObject(copy, off, off);
    state.objects.push(copy);
    state.selectedId = copy.id;
    refreshAll();
  }

  function duplicateSelected() {
    if (state.selectedId == null) return;
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) return;
    pushHistory();
    const copy = JSON.parse(JSON.stringify(o));
    copy.id = uid();
    delete copy.locked;
    const off = state.grid.size; // one grid box offset
    offsetObject(copy, off, off);
    state.objects.push(copy);
    state.selectedId = copy.id;
    refreshAll();
  }

  function offsetObject(o, dx, dy) {
    switch (o.type) {
      case 'room':
      case 'door':
      case 'window':
      case 'text':
        o.x = (o.x || 0) + dx;
        o.y = (o.y || 0) + dy;
        break;
      case 'wall':
      case 'measure':
        o.x1 += dx; o.y1 += dy;
        o.x2 += dx; o.y2 += dy;
        break;
    }
  }

  function zoomBy(f) {
    const r = canvas.getBoundingClientRect();
    const sx = r.width / 2, sy = r.height / 2;
    const before = screenToWorld(sx, sy);
    state.view.zoom = Math.max(0.1, Math.min(8, state.view.zoom * f));
    const after = screenToWorld(sx, sy);
    const s = state.pxPerMeter * state.view.zoom;
    state.view.x += (after.x - before.x) * s;
    state.view.y += (after.y - before.y) * s;
    draw();
  }

  function resetView() {
    state.view = { x: 60, y: 60, zoom: 1 };
    draw();
  }

  // ---------- Properties / Layers ----------
  function refreshProps() {
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) {
      propsEmpty.hidden = false;
      propsForm.hidden = true;
      return;
    }
    propsEmpty.hidden = true;
    propsForm.hidden = false;
    const b = getBounds(o);
    propEls.label.value = o.label || o.text || '';
    propEls.x.value = fmtLenInput(b.x);
    propEls.y.value = fmtLenInput(b.y);
    propEls.w.value = fmtLenInput(b.w);
    propEls.h.value = fmtLenInput(b.h);
    // W/H rows are only meaningful for rooms; hide for everything else since
    // other types are sized via dedicated fields (length via endpoints,
    // door/window via Opening width).
    const showWH = (o.type === 'room');
    propEls.w.parentElement.style.display = showWH ? '' : 'none';
    propEls.h.parentElement.style.display = showWH ? '' : 'none';
    propEls.fill.value = toHex(o.fill || '#e8f0ff');
    propEls.stroke.value = toHex(o.stroke || '#1f3a8a');
    propEls.strokew.value = o.strokeWidth || 2;
    if (o.type === 'wall') {
      propThicknessRow.hidden = false;
      propEls.thickness.value = fmtLenInput(o.thickness || state.defaultWallThickness);
    } else {
      propThicknessRow.hidden = true;
    }
    if (o.type === 'door' || o.type === 'window') {
      propOpeningRow.hidden = false;
      propOpeningWLabel.textContent =
        (o.type === 'door' ? 'Door width' : 'Window width') +
        (state.units === 'ft' ? " (ft'in\")" : ' (m)');
      propEls.openingW.value = fmtLenInput(o.w);
      propEls.rotation.value = Math.round((o.rot || 0) * 10) / 10;
    } else {
      propOpeningRow.hidden = true;
    }
    // Disable all property inputs when the object is locked
    Object.values(propEls).forEach(el => { if (el) el.disabled = !!o.locked; });
  }

  // Layer category metadata + active tab
  const LAYER_CATEGORIES = [
    { key: 'room',    label: 'Rooms',        icon: 'i-cat-room' },
    { key: 'wall',    label: 'Walls',        icon: 'i-cat-wall' },
    { key: 'door',    label: 'Doors',        icon: 'i-cat-door' },
    { key: 'window',  label: 'Windows',      icon: 'i-cat-window' },
    { key: 'text',    label: 'Text',         icon: 'i-cat-text' },
    { key: 'measure', label: 'Measurements', icon: 'i-cat-measure' },
  ];
  let activeLayerTab = 'room';
  const layerTabs = document.getElementById('layer-tabs');

  function refreshLayers() {
    // Bucket objects by type, preserving array order (high-z first).
    const buckets = new Map();
    for (const cat of LAYER_CATEGORIES) buckets.set(cat.key, []);
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (buckets.has(o.type)) buckets.get(o.type).push(o);
    }

    // ---- Tabs ----
    layerTabs.innerHTML = '';
    // If the current active tab has no items, fall back to the first tab that does.
    const activeHasItems = (buckets.get(activeLayerTab) || []).length > 0;
    if (!activeHasItems) {
      const firstWithItems = LAYER_CATEGORIES.find(c => (buckets.get(c.key) || []).length > 0);
      if (firstWithItems) activeLayerTab = firstWithItems.key;
    }
    for (const cat of LAYER_CATEGORIES) {
      const count = (buckets.get(cat.key) || []).length;
      // Hide empty type-tabs entirely
      if (count === 0) continue;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'layer-tab' + (cat.key === activeLayerTab ? ' active' : '');
      tab.title = cat.label;
      tab.dataset.key = cat.key;
      tab.innerHTML =
        `<span class="tab-icon"><svg class="ic"><use href="#${cat.icon}"/></svg></span>` +
        `<span class="tab-label">${cat.label}</span>` +
        `<span class="tab-count">${count}</span>`;
      tab.addEventListener('click', () => {
        activeLayerTab = cat.key;
        refreshLayers();
      });
      layerTabs.appendChild(tab);
    }

    // ---- List ----
    layerList.innerHTML = '';
    const items = buckets.get(activeLayerTab) || [];
    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'layer-empty';
      empty.textContent = 'No items.';
      layerList.appendChild(empty);
      return;
    }
    for (const o of items) {
      layerList.appendChild(buildLayerRow(o));
    }
  }

  function buildLayerRow(o) {
    const li = document.createElement('li');
    li.className = 'layer-item';
    li.dataset.id = String(o.id);
    li.draggable = true;
    if (o.id === state.selectedId) li.classList.add('selected');
    if (o.locked) li.classList.add('locked');

    const grip = document.createElement('span');
    grip.className = 'layer-grip';
    grip.title = 'Drag to reorder';
    grip.innerHTML = '<svg class="ic"><use href="#i-grip"/></svg>';
    li.appendChild(grip);

    const name = o.label || o.text || `${o.type} #${o.id}`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'layer-name';
    nameSpan.title = 'Double-click to rename';
    nameSpan.textContent = name;
    nameSpan.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      startInlineRename(li, nameSpan, o);
    });
    li.appendChild(nameSpan);

    const actions = document.createElement('span');
    actions.className = 'layer-actions';

    const lock = document.createElement('button');
    lock.className = 'lock';
    lock.innerHTML = `<svg class="ic"><use href="#${o.locked ? 'i-lock' : 'i-unlock'}"/></svg>`;
    lock.title = o.locked ? 'Unlock' : 'Lock (prevents move/resize/delete)';
    lock.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pushHistory();
      o.locked = !o.locked;
      refreshAll();
    });
    actions.appendChild(lock);

    const del = document.createElement('button');
    del.className = 'del';
    del.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    del.title = o.locked ? 'Unlock first to delete' : 'Delete';
    del.disabled = !!o.locked;
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (o.locked) return;
      pushHistory();
      state.objects = state.objects.filter(x => x.id !== o.id);
      if (state.selectedId === o.id) state.selectedId = null;
      refreshAll();
    });
    actions.appendChild(del);

    li.appendChild(actions);
    li.addEventListener('click', () => {
      state.selectedId = o.id;
      refreshAll();
    });

    // ---- Drag and drop reordering (same-category only) ----
    li.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(o.id));
      ev.dataTransfer.setData('application/x-layer-type', o.type);
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      layerList.querySelectorAll('.drop-above, .drop-below')
        .forEach(el => el.classList.remove('drop-above', 'drop-below'));
    });
    li.addEventListener('dragover', (ev) => {
      const fromType = ev.dataTransfer.getData('application/x-layer-type');
      // Only allow drop within same category. (getData is empty in some
      // browsers during dragover; fall back to allowing the drop and
      // re-validating in the drop handler.)
      if (fromType && fromType !== o.type) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const before = (ev.clientY - rect.top) < rect.height / 2;
      li.classList.toggle('drop-above', before);
      li.classList.toggle('drop-below', !before);
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drop-above', 'drop-below');
    });
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const fromId = parseInt(ev.dataTransfer.getData('text/plain'), 10);
      if (isNaN(fromId) || fromId === o.id) return;
      const fromObj = state.objects.find(x => x.id === fromId);
      if (!fromObj || fromObj.type !== o.type) return; // category guard
      const rect = li.getBoundingClientRect();
      const before = (ev.clientY - rect.top) < rect.height / 2;
      reorderLayers(fromId, o.id, before);
    });

    return li;
  }

  // Reorder objects so that `fromId` is dropped just above (`before` = true)
  // or just below the target id, in the **layers list** (which renders
  // top -> bottom from highest z to lowest).
  function reorderLayers(fromId, targetId, before) {
    const fromIdx = state.objects.findIndex(x => x.id === fromId);
    const targetIdx = state.objects.findIndex(x => x.id === targetId);
    if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return;
    pushHistory();
    const [item] = state.objects.splice(fromIdx, 1);
    // Recompute target index after removal.
    let tIdx = state.objects.findIndex(x => x.id === targetId);
    // List is reversed visually: dropping ABOVE in the UI = HIGHER z = AFTER target in array.
    let insertAt = before ? tIdx + 1 : tIdx;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > state.objects.length) insertAt = state.objects.length;
    state.objects.splice(insertAt, 0, item);
    refreshAll();
  }

  function startInlineRename(li, nameSpan, o) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'layer-rename';
    input.value = o.label || o.text || '';
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let cancelled = false;
    let committed = false;
    const commit = () => {
      if (committed || cancelled) return;
      committed = true;
      const v = input.value.trim();
      const oldName = o.label || o.text || '';
      if (v === oldName) { refreshAll(); return; }
      pushHistory();
      if (o.type === 'text') o.text = v || 'Text';
      else o.label = v;
      refreshAll();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; refreshAll(); }
    });
    input.addEventListener('blur', commit);
  }

  function refreshAll() {
    refreshProps();
    refreshLayers();
    draw();
    scheduleAutosave();
    updateSaveButton();
  }

  // ---------- Autosave (debounced) ----------
  // Saves the current layout to localStorage shortly after any state change,
  // so the user never loses work if they close the tab.
  let autosaveTimer = null;
  let suppressAutosave = false;   // true while loading, to avoid feedback loops
  function scheduleAutosave() {
    if (suppressAutosave) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(doAutosave, 400);
  }
  function doAutosave() {
    autosaveTimer = null;
    try {
      const snap = serialize();
      localStorage.setItem(STORAGE_KEY, snap);
      lastSavedSnapshot = snap;
      updateSaveButton();
      flash('Auto-saved');
    } catch (err) {
      // Storage may be full or unavailable (private mode, quota, etc.)
      flash('Auto-save failed');
    }
  }

  // Track dirty state — disable Save and show "Saved" when nothing has changed
  // since the last successful save.
  let lastSavedSnapshot = null;
  function updateSaveButton() {
    const btn = document.getElementById('btn-save');
    if (!btn) return;
    const labelEl = btn.querySelector('span');
    const dirty = lastSavedSnapshot !== serialize();
    btn.disabled = !dirty;
    btn.classList.toggle('is-saved', !dirty);
    if (labelEl) labelEl.textContent = dirty ? 'Save' : 'Saved';
    btn.title = dirty ? 'Save to browser (Ctrl+S)' : 'All changes saved';
  }
  // Best-effort flush before leaving the page
  window.addEventListener('beforeunload', () => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      try { localStorage.setItem(STORAGE_KEY, serialize()); } catch {}
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function toHex(c) {
    if (!c) return '#000000';
    if (c.startsWith('#')) return c.length === 7 ? c : '#000000';
    // basic rgb -> hex
    const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (m) return '#' + [1,2,3].map(i => parseInt(m[i]).toString(16).padStart(2,'0')).join('');
    return '#000000';
  }

  // ---------- Persistence ----------
  function serialize() {
    return JSON.stringify({
      version: 1,
      pxPerMeter: state.pxPerMeter,
      pxPerBox: state.pxPerBox,
      grid: state.grid,
      showDims: state.showDims,
      units: state.units,
      defaultWallThickness: state.defaultWallThickness,
      projectName: state.projectName,
      objects: state.objects,
      nextId: state.nextId,
    }, null, 2);
  }
  function deserialize(s) {
    try {
      const d = JSON.parse(s);
      pushHistory();
      suppressAutosave = true;
      state.pxPerMeter = d.pxPerMeter || 40;
      state.pxPerBox = d.pxPerBox || 50;
      state.grid = d.grid || state.grid;
      state.showDims = d.showDims !== undefined ? d.showDims : true;
      state.units = d.units === 'ft' ? 'ft' : 'm';
      if (typeof d.defaultWallThickness === 'number') state.defaultWallThickness = d.defaultWallThickness;
      if (typeof d.projectName === 'string' && d.projectName.trim()) state.projectName = d.projectName;
      state.objects = d.objects || [];
      state.nextId = d.nextId || (Math.max(0, ...state.objects.map(o => o.id)) + 1);
      state.selectedId = null;
      // Reflect in UI
      document.getElementById('opt-grid').checked = !!state.grid.show;
      document.getElementById('opt-snap').checked = !!state.grid.snap;
      document.getElementById('opt-dims').checked = !!state.showDims;
      document.getElementById('opt-units').value = state.units;
      document.getElementById('opt-box-px').value = String(state.pxPerBox);
      const pn = document.getElementById('project-name');
      if (pn) pn.value = state.projectName;
      refreshUnitLabels();
      refreshAll();
      suppressAutosave = false;
      return true;
    } catch (err) {
      suppressAutosave = false;
      alert('Could not load layout: ' + err.message);
      return false;
    }
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Build a safe export filename from the project name + a local timestamp.
  // Returns e.g. "My Plot_2026-05-10_14-32-08.json".
  function exportFilename(ext) {
    const raw = (state.projectName || 'Untitled Layout').trim() || 'Untitled Layout';
    // Strip characters that are invalid in filenames on Windows/macOS/Linux.
    const safe = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 60).trim() || 'Untitled Layout';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
                  `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${safe}_${stamp}.${ext}`;
  }
  function exportPNG() {
    // Render a clean copy without selection halo or status overlays.
    const wasSelected = state.selectedId;
    state.selectedId = null;
    draw();
    const off = document.createElement('canvas');
    const r = canvas.getBoundingClientRect();
    const scale = 2;
    off.width = r.width * scale;
    off.height = r.height * scale;
    const octx = off.getContext('2d');
    octx.drawImage(canvas, 0, 0, off.width, off.height);
    off.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = exportFilename('png');
      a.click();
      URL.revokeObjectURL(a.href);
    });
    state.selectedId = wasSelected;
    draw();
  }

  function flash(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    // Force reflow so the .show transition replays even on rapid successive flashes.
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(flash._timer);
    flash._timer = setTimeout(() => {
      t.classList.remove('show');
      // Hide after the transition completes
      setTimeout(() => { if (!t.classList.contains('show')) t.hidden = true; }, 200);
    }, 1600);
  }

  // Collapsible side-panel cards (Properties / Canvas / Layers).
  // Persists per-card collapsed state in localStorage.
  const COLLAPSE_KEY = 'plotly.cards.collapsed.v1';
  function loadCollapsedSet() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw));
    } catch { return new Set(); }
  }
  function saveCollapsedSet(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
  }
  function initCollapsibleCards() {
    const collapsed = loadCollapsedSet();
    document.querySelectorAll('.card.collapsible').forEach(card => {
      const key = card.dataset.card;
      const head = card.querySelector('.card-head');
      const setState = (isCollapsed) => {
        card.classList.toggle('collapsed', isCollapsed);
        if (head) head.setAttribute('aria-expanded', String(!isCollapsed));
      };
      setState(collapsed.has(key));
      if (head) {
        head.addEventListener('click', () => {
          const nowCollapsed = !card.classList.contains('collapsed');
          setState(nowCollapsed);
          if (nowCollapsed) collapsed.add(key); else collapsed.delete(key);
          saveCollapsedSet(collapsed);
        });
      }
    });
  }

  // ---------- Init ----------
  window.addEventListener('resize', resizeCanvas);
  resetView();
  resizeCanvas();
  refreshUnitLabels();
  initCollapsibleCards();
  // Auto-load last saved layout if present
  const last = localStorage.getItem(STORAGE_KEY);
  if (last) {
    try { deserialize(last); } catch { /* ignore */ }
  } else {
    // Seed with a sample plot so the canvas isn't blank on first load
    state.objects = [
      makeObject('room', { x: 0, y: 0, w: 12, h: 8, label: 'Plot Boundary', fill: '#fff8e6', stroke: '#a0741b', strokeWidth: 3 }),
      makeObject('room', { x: 1, y: 1, w: 5, h: 4, label: 'Living Room', fill: '#e8f0ff', stroke: '#1f3a8a' }),
      makeObject('room', { x: 6.2, y: 1, w: 4.8, h: 3, label: 'Kitchen', fill: '#e7f7ec', stroke: '#1f7a3a' }),
      makeObject('room', { x: 1, y: 5.2, w: 4, h: 2.8, label: 'Bedroom', fill: '#fce6f0', stroke: '#9a1f6a' }),
      makeObject('door', { x: 3, y: 5, w: 0.9, rot: 0 }),
    ];
    refreshAll();
  }
  // Treat the freshly initialized state as "saved" so the Save button starts disabled.
  lastSavedSnapshot = serialize();
  updateSaveButton();
})();
