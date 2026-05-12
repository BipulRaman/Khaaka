/* Khaaka — a tiny, dependency-free 2D layout-map editor.
   Coordinate system: world units = meters. Rendering scales by `pxPerMeter` * zoom. */

(() => {
  'use strict';

  // ---------- State ----------
  // Each open tab owns its own state object. The module-level `state` is a
  // reference to the active tab's state, swapped in switchToTab(). Code that
  // reads/writes `state.X` continues to work — it just always points at the
  // active tab.
  function makeBlankState() {
    return {
      objects: [],        // all shapes in z-order
      selectedId: null,
      tool: 'select',
      nextId: 1,
      view: { x: 0, y: 0, zoom: 1 }, // pan in screen px, zoom multiplier
      pxPerMeter: 40,
      pxPerBox: 25,        // screen pixels per grid box (drives pxPerMeter)
      grid: { show: true, snap: true, size: 0.3048 }, // 1 ft default
      showDims: true,
      units: 'ft', // 'm' = meters, 'ft' = feet & inches
      defaultWallThickness: 0.1524, // 6" in meters
      projectName: 'Untitled Layout',
      history: [],
      future: [],
    };
  }
  let state = makeBlankState();

  const M_PER_FT = 0.3048;

  // Legacy single-tab key (still read once at startup for migration).
  const STORAGE_KEY = 'plotly.layout.v1';
  // Multi-tab keys
  const TABS_KEY = 'khaaka.tabs.v1';            // [{ id, name, snapJSON, fileName }]
  const ACTIVE_TAB_KEY = 'khaaka.tabs.active.v1';

  // ---------- DOM ----------
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('hint');
  const layerList = document.getElementById('layer-list');

  // ---------- Limited color palettes (light shades only) ----------
  const FILL_SWATCHES = [
    '#ffffff', '#fff8e6', '#fde9ef', '#fce5d8', '#f3e9d2',
    '#e7f7ec', '#e0f2fe', '#e8f0ff', '#efe8ff', '#eef1f6',
  ];
  const STROKE_SWATCHES = [
    '#cbd5e1', '#94a3b8', '#7da3e8', '#7ec295', '#e88b9f',
    '#a48de0', '#c8a05a', '#1f3a8a', '#a3b8d8', '#d4b896',
  ];

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
      ctx.strokeStyle = o.stroke || '#4a2e1c';
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
      // dimSide: 0 = default side, 1 = flipped to the other side of the wall
      const sign = (o.dimSide === 1 || o.dimSide === -1) ? -1 : 1;
      o._dimLabel = drawDimension(o.x1, o.y1, o.x2, o.y2, fmtLen(len), false, (t / 2 + 12) * sign);
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

  // Hit-test wall / door / window dimension labels (rendered in the
  // dimensions pass). Returns the matched object, or null. `sx`,`sy` are
  // screen-space px relative to the canvas top-left.
  function hitDimensionLabel(sx, sy) {
    for (let i = state.objects.length - 1; i >= 0; i--) {
      const o = state.objects[i];
      if (o.type !== 'door' && o.type !== 'window' && o.type !== 'wall') continue;
      const r = o._dimLabel;
      if (!r) continue;
      // Primary: rotated AABB hit test in the pill's local frame.
      const cos = Math.cos(-r.angle), sin = Math.sin(-r.angle);
      const lx = (sx - r.cx) * cos - (sy - r.cy) * sin;
      const ly = (sx - r.cx) * sin + (sy - r.cy) * cos;
      if (Math.abs(lx) <= r.halfW && Math.abs(ly) <= r.halfH) return o;
      // Fallback: forgiving radius around the label center (covers any
      // small rotation rounding errors and gives users a slightly larger
      // tap target).
      const radius = Math.max(r.halfW, r.halfH) + 4;
      const dx = sx - r.cx, dy = sy - r.cy;
      if (dx * dx + dy * dy <= radius * radius) return o;
    }
    return null;
  }

  // ---------- Status / Hint ----------
  function setHint(msg) { hint.textContent = msg; }
  function updateStatus() {
    const pct = document.getElementById('btn-zoom-reset-bar');
    if (pct) pct.textContent = `${Math.round(state.view.zoom * 100)}%`;
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

    // Click on a dimension label:
    //  - wall → flip label to the other side of the wall
    //  - door / window → cycle the label around the right angle (4 positions)
    // Only intercept when the Select tool is active so other drawing tools
    // work normally. Allowed even on locked objects (cosmetic, not geometry).
    if (state.showDims && state.tool === 'select') {
      const dimHit = hitDimensionLabel(sx, sy);
      if (dimHit) {
        pushHistory();
        if (dimHit.type === 'wall') {
          // Flip side: 0 ↔ 1 (legacy -1/+1 also collapse to this)
          dimHit.dimSide = (dimHit.dimSide === 1 || dimHit.dimSide === -1) ? 0 : 1;
        } else {
          dimHit.dimSide = (doorDimSide(dimHit) + 1) % 4;
        }
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
      obj = makeObject('wall', { x1: sw.x, y1: sw.y, x2: sw.x, y2: sw.y, thickness: state.defaultWallThickness, stroke: '#4a2e1c' });
    } else if (state.tool === 'door') {
      obj = makeObject('door', { x: sw.x, y: sw.y, w: 0.9, rot: 0 });
      state.objects.push(obj);
      state.selectedId = obj.id;
      drag = null;
      switchToSelectTool();
      refreshAll();
      return;
    } else if (state.tool === 'window') {
      obj = makeObject('window', { x: sw.x, y: sw.y, w: 1.2, rot: 0 });
      state.objects.push(obj);
      state.selectedId = obj.id;
      drag = null;
      switchToSelectTool();
      refreshAll();
      return;
    } else if (state.tool === 'text') {
      // Capture the placement coords now (sw is per-event); the modal is async.
      const placeAt = { x: sw.x, y: sw.y };
      drag = null;
      switchToSelectTool();
      refreshAll();
      showModal({
        kind: 'prompt',
        title: 'Add text',
        message: 'Enter the text to place on the canvas.',
        defaultValue: 'Label',
        placeholder: 'Label',
        okText: 'Add',
      }).then(txt => {
        if (txt == null) return;
        const trimmed = String(txt).trim();
        if (!trimmed) return;
        const o = makeObject('text', { x: placeAt.x, y: placeAt.y, text: trimmed, size: 14, fill: '#111827' });
        state.objects.push(o);
        state.selectedId = o.id;
        refreshAll();
      });
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
      // Idle hover: show pointer cursor over clickable dimension labels.
      if (state.showDims && state.tool === 'select' && hitDimensionLabel(sx, sy)) {
        canvas.style.cursor = 'pointer';
      } else if (canvas.style.cursor === 'pointer') {
        canvas.style.cursor = 'default';
      }
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
      } else {
        // Successful create — auto-switch back to Select / Move so the next
        // click doesn't accidentally start another shape.
        switchToSelectTool();
      }
    }
    drag = null;
    canvas.style.cursor = 'default';
    refreshAll();
  });

  // Programmatically activate the Select tool (also updates toolbar state).
  function switchToSelectTool() {
    if (state.tool === 'select') return;
    const btn = document.querySelector('.tool[data-tool="select"]');
    if (btn) btn.click();
    else state.tool = 'select';
  }

  // Create 4 wall objects along a room's edges (top, right, bottom, left).
  // Walls are appended after the room so they render on top of the fill.
  // Returns the array of new wall objects.
  function addWallsForRoom(room) {
    const t = state.defaultWallThickness;
    const stroke = '#4a2e1c';
    const x1 = room.x, y1 = room.y;
    const x2 = room.x + room.w, y2 = room.y + room.h;
    const sides = [
      { x1, y1,     x2,     y2: y1 }, // top
      { x1: x2, y1, x2,     y2 },     // right
      { x1, y1: y2, x2,     y2 },     // bottom
      { x1, y1,     x2: x1, y2 },     // left
    ];
    const created = [];
    for (const s of sides) {
      const w = makeObject('wall', { ...s, thickness: t, stroke });
      state.objects.push(w);
      created.push(w);
    }
    return created;
  }

  // ---------- Right-click context menu ----------
  const ctxMenu = document.getElementById('context-menu');

  function hideContextMenu() {
    if (!ctxMenu) return;
    ctxMenu.hidden = true;
    ctxMenu.setAttribute('aria-hidden', 'true');
    ctxMenu.innerHTML = '';
  }

  function ctxItem(label, onClick, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (opts.danger ? ' danger' : '');
    b.disabled = !!opts.disabled;
    b.innerHTML =
      `<span>${label}</span>` +
      (opts.shortcut ? `<span class="ctx-shortcut">${opts.shortcut}</span>` : '');
    b.addEventListener('click', () => {
      if (b.disabled) return;
      hideContextMenu();
      onClick();
    });
    return b;
  }

  // Compact horizontal icon-button row for the context menu (e.g. Undo / Redo
  // / Delete at the top). Each item:
  //   { iconId, title, shortcut?, onClick, disabled, danger }
  function ctxIconRow(items, opts = {}) {
    const row = document.createElement('div');
    row.className = 'ctx-icon-row' + (opts.compact ? ' compact' : '');
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-icon-btn' + (it.danger ? ' danger' : '');
      b.disabled = !!it.disabled;
      b.title = it.title || '';
      b.setAttribute('aria-label', it.title || '');
      b.innerHTML =
        (it.text != null
          ? `<span class="ctx-icon-text">${it.text}</span>`
          : `<svg class="ic"><use href="#${it.iconId}"/></svg>`) +
        (it.shortcut ? `<span class="ctx-icon-kbd">${it.shortcut}</span>` : '');
      b.addEventListener('click', () => {
        if (b.disabled) return;
        hideContextMenu();
        it.onClick();
      });
      row.appendChild(b);
    });
    return row;
  }
  function ctxSep() {
    const d = document.createElement('div');
    d.className = 'ctx-sep';
    return d;
  }
  function ctxSection(text) {
    const d = document.createElement('div');
    d.className = 'ctx-section';
    d.textContent = text;
    return d;
  }
  // Toggle row — shows a check on the left when active. Closes the menu and
  // dispatches `change` on the linked sidebar input so the existing handler
  // fires (autosave, redraw, state sync).
  function ctxToggle(label, isOn, inputId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item ctx-toggle' + (isOn ? ' on' : '');
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(!!isOn));
    b.innerHTML =
      `<span class="ctx-check" aria-hidden="true"></span>` +
      `<span class="ctx-toggle-label">${label}</span>`;
    b.addEventListener('click', () => {
      hideContextMenu();
      const chk = document.getElementById(inputId);
      if (chk) { chk.checked = !chk.checked; chk.dispatchEvent(new Event('change')); }
    });
    return b;
  }
  function ctxDisplayToggles(frag) {
    frag.appendChild(ctxToggle('Show grid', state.grid.show, 'opt-grid'));
    frag.appendChild(ctxToggle('Snap to grid', state.grid.snap, 'opt-snap'));
    frag.appendChild(ctxToggle('Show dimensions', state.showDims, 'opt-dims'));
  }
  function ctxSwatchRow(palette, currentHex, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'ctx-swatches';
    const target = (currentHex || '').toLowerCase();
    palette.forEach(hex => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (hex.toLowerCase() === target ? ' active' : '');
      b.style.backgroundColor = hex;
      b.title = hex;
      b.addEventListener('click', () => { hideContextMenu(); onPick(hex); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // Inline numeric stepper used inside the context menu (e.g. Outline width).
  // Stays open while clicking +/-; the value updates live and `onChange`
  // receives the clamped new value.
  function ctxStepper(getValue, onChange, opts = {}) {
    const min = opts.min ?? 1;
    const max = opts.max ?? 20;
    const step = opts.step ?? 1;
    const wrap = document.createElement('div');
    wrap.className = 'ctx-stepper';
    const dec = document.createElement('button');
    dec.type = 'button';
    dec.className = 'ctx-step-btn';
    dec.textContent = '\u2212'; // minus sign
    const val = document.createElement('span');
    val.className = 'ctx-step-value';
    const inc = document.createElement('button');
    inc.type = 'button';
    inc.className = 'ctx-step-btn';
    inc.textContent = '+';
    const sync = () => {
      const v = getValue();
      val.textContent = String(v);
      dec.disabled = v <= min;
      inc.disabled = v >= max;
    };
    const bump = (delta) => (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = getValue();
      const next = Math.max(min, Math.min(max, cur + delta));
      if (next === cur) return;
      onChange(next);
      sync();
    };
    dec.addEventListener('click', bump(-step));
    inc.addEventListener('click', bump(+step));
    sync();
    wrap.appendChild(dec);
    wrap.appendChild(val);
    wrap.appendChild(inc);
    return wrap;
  }

  // Compact compound length editor for the right-click menu. Looks like
  // `[Width  ][ 12 ft  3 in ]` on a single row. Updates `o` live as the
  // user types and calls `onCommit(meters)` for each change. Min major 0.
  function ctxLenInput(label, getMeters, onCommit) {
    const row = document.createElement('div');
    row.className = 'ctx-section-row ctx-len-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = label;
    row.appendChild(lbl);

    const isFt = state.units === 'ft';
    const wrap = document.createElement('div');
    wrap.className = 'len-input ctx-len-input';
    const major = document.createElement('input');
    major.type = 'number';
    major.className = 'len-major';
    major.min = '0';
    major.step = '1';
    const uMaj = document.createElement('span');
    uMaj.className = 'len-major-unit';
    uMaj.textContent = isFt ? 'ft' : 'm';
    const minor = document.createElement('input');
    minor.type = 'number';
    minor.className = 'len-minor';
    minor.min = '0';
    minor.step = '0.5';
    const uMin = document.createElement('span');
    uMin.className = 'len-minor-unit';
    uMin.textContent = isFt ? 'in' : 'cm';
    wrap.append(major, uMaj, minor, uMin);
    row.appendChild(wrap);

    const sizeOf = (input) => {
      const len = (input.value || '').length;
      input.size = Math.max(1, Math.min(6, len || 1));
    };

    // Initial decompose
    const writeFromMeters = (m) => {
      if (m == null || isNaN(m)) { major.value = ''; minor.value = ''; }
      else if (isFt) {
        const totalIn = (m / M_PER_FT) * 12;
        const halfIn = Math.round(totalIn * 2) / 2;
        let ft = Math.trunc(halfIn / 12);
        let inches = halfIn - ft * 12;
        if (inches < 0) { inches += 12; ft -= 1; }
        if (inches >= 12) { ft += 1; inches -= 12; }
        major.value = String(ft);
        minor.value = (inches % 1 === 0) ? String(inches) : inches.toFixed(1);
      } else {
        const totalCm = Math.round(m * 1000) / 10;
        let mm = Math.trunc(totalCm / 100);
        let cm = Math.round((totalCm - mm * 100) * 10) / 10;
        if (cm < 0) { cm += 100; mm -= 1; }
        if (cm >= 100) { mm += 1; cm -= 100; }
        major.value = String(mm);
        minor.value = (cm % 1 === 0) ? String(cm) : cm.toFixed(1);
      }
      sizeOf(major); sizeOf(minor);
    };
    writeFromMeters(getMeters());

    const onInput = () => {
      sizeOf(major); sizeOf(minor);
      const a = parseFloat(major.value);
      const b = parseFloat(minor.value);
      const aOk = !isNaN(a), bOk = !isNaN(b);
      if (!aOk && !bOk) return;
      let meters;
      if (isFt) meters = ftToM((aOk ? a : 0) + (bOk ? b : 0) / 12);
      else meters = (aOk ? a : 0) + (bOk ? b : 0) / 100;
      if (meters > 0) onCommit(meters);
    };
    major.addEventListener('input', onInput);
    minor.addEventListener('input', onInput);
    // Don't let Esc inside the input close the whole menu while editing
    [major, minor].forEach(i => i.addEventListener('keydown', (e) => e.stopPropagation()));
    // Keep the menu open while clicking inside the input
    wrap.addEventListener('mousedown', (e) => e.stopPropagation());
    return row;
  }

  // Inline single-line Zoom row: `[Zoom ][ − 100% + ]`
  function ctxZoomRow() {
    const row = document.createElement('div');
    row.className = 'ctx-section-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = 'Zoom';
    row.appendChild(lbl);

    const group = document.createElement('div');
    group.className = 'ctx-presets ctx-zoom-presets';
    const items = [
      { text: '−', title: 'Zoom out (−)', onClick: () => zoomBy(1 / 1.2) },
      { text: `${Math.round(state.view.zoom * 100)}%`, title: 'Reset view (0)', onClick: resetView },
      { text: '+', title: 'Zoom in (+)', onClick: () => zoomBy(1.2) },
    ];
    items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-preset';
      b.textContent = it.text;
      b.title = it.title;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        it.onClick();
        // Live-refresh the % label without rebuilding the menu.
        const pct = group.children[1];
        if (pct) pct.textContent = `${Math.round(state.view.zoom * 100)}%`;
      });
      group.appendChild(b);
    });
    row.appendChild(group);
    return row;
  }

  // Angle preset row for doors / windows — `[Angle ][ 0° 90° 180° 270° ]`.
  // The button matching the current angle is highlighted; click sets `o.rot`.
  function ctxAnglePresets(o) {
    const row = document.createElement('div');
    row.className = 'ctx-section-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = 'Angle';
    row.appendChild(lbl);

    const group = document.createElement('div');
    group.className = 'ctx-presets';
    const cur = ((o.rot || 0) % 360 + 360) % 360;
    [0, 90, 180, 270].forEach(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-preset' + (Math.round(cur) === a ? ' active' : '');
      b.textContent = `${a}\u00b0`;
      b.disabled = !!o.locked;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (o.locked) return;
        pushHistory();
        o.rot = a;
        // Live-update active highlight without rebuilding the whole menu
        group.querySelectorAll('.ctx-preset').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        draw();
        refreshLayers();
        scheduleAutosave();
      });
      group.appendChild(b);
    });
    row.appendChild(group);
    return row;
  }

  // Flip row — single button that mirrors the door/window swing direction
  // (re-uses the existing `flipOpening`, same effect as double-clicking).
  function ctxFlipRow(o) {
    const row = document.createElement('div');
    row.className = 'ctx-section-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctx-section ctx-inline-section';
    lbl.textContent = 'Flip';
    row.appendChild(lbl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-preset';
    btn.textContent = 'Mirror swing';
    btn.disabled = !!o.locked;
    btn.title = 'Mirror the opening so the swing arc reverses';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (o.locked) return;
      pushHistory();
      flipOpening(o);
      draw();
      refreshLayers();
      scheduleAutosave();
    });
    const group = document.createElement('div');
    group.className = 'ctx-presets';
    group.appendChild(btn);
    row.appendChild(group);
    return row;
  }

  // Rename menu row that swaps itself into an inline <input> on click.
  // Enter / blur commits, Escape cancels. The menu stays open while editing.
  // Allowed even when the object is locked (lock blocks geometry, not labels).
  function buildRenameItem(o) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.innerHTML = `<span>Rename</span><span class="ctx-shortcut">F2</span>`;

    const startEdit = () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ctx-rename-input';
      input.value = o.label || o.text || '';
      input.placeholder = 'Name…';
      input.maxLength = 80;
      btn.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const commit = () => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        const prev = o.label || (o.type === 'text' ? o.text : '') || '';
        if (next !== prev) {
          pushHistory();
          o.label = next;
          if (o.type === 'text') o.text = next;
          refreshAll();
          scheduleAutosave();
        }
        hideContextMenu();
      };
      const cancel = () => {
        if (done) return;
        done = true;
        hideContextMenu();
      };
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      });
      input.addEventListener('blur', commit);
      // Stop clicks inside the input from bubbling to the outside-click handler
      input.addEventListener('mousedown', (ev) => ev.stopPropagation());
    };

    btn.addEventListener('click', startEdit);
    return btn;
  }

  function buildObjectMenu(o) {
    const frag = document.createDocumentFragment();
    const idx = state.objects.indexOf(o);
    const isFront = idx === state.objects.length - 1;
    const isBack = idx === 0;
    const supportsFill = o.type === 'room' || o.type === 'window' || o.type === 'text';
    const supportsStroke = o.type !== 'text';
    const supportsOutline = o.type === 'room' || o.type === 'wall';

    // Quick-action icon row: Undo / Redo / Delete
    frag.appendChild(ctxIconRow([
      { iconId: 'i-undo',  title: 'Undo (Ctrl+Z)', shortcut: 'Undo',   onClick: undo, disabled: state.history.length === 0 },
      { iconId: 'i-redo',  title: 'Redo (Ctrl+Y)', shortcut: 'Redo',   onClick: redo, disabled: state.future.length === 0 },
      { iconId: 'i-trash', title: 'Delete (Del)',  shortcut: 'Delete', danger: true,  disabled: !!o.locked,
        onClick: () => { state.selectedId = o.id; deleteSelected(); } },
    ]));
    frag.appendChild(ctxSep());

    frag.appendChild(buildRenameItem(o));

    frag.appendChild(ctxSep());

    frag.appendChild(ctxItem(o.locked ? 'Unlock' : 'Lock', () => {
      pushHistory();
      o.locked = !o.locked;
      refreshAll();
      scheduleAutosave();
    }));
    frag.appendChild(ctxItem('Bring to front', () => {
      if (isFront) return;
      pushHistory();
      state.objects.splice(idx, 1);
      state.objects.push(o);
      refreshAll();
      scheduleAutosave();
    }, { disabled: isFront }));
    frag.appendChild(ctxItem('Send to back', () => {
      if (isBack) return;
      pushHistory();
      state.objects.splice(idx, 1);
      state.objects.unshift(o);
      refreshAll();
      scheduleAutosave();
    }, { disabled: isBack }));

    // Room-specific: add 4 walls along the room's edges as separate,
    // individually-editable wall objects.
    if (o.type === 'room') {
      frag.appendChild(ctxItem('Add walls', () => {
        pushHistory();
        const walls = addWallsForRoom(o);
        flash(`Added ${walls.length} walls`);
        refreshAll();
        scheduleAutosave();
      }, { disabled: !!o.locked }));
    }

    // Inline length editors (Width / Height / Thickness) — only for the
    // types where these dimensions are directly editable.
    const dimRows = [];
    const commitBound = (key) => (m) => {
      if (o.locked) return;
      pushHistory();
      const b = getBounds(o);
      setBounds(o, { ...b, [key]: m });
      draw();
      refreshLayers();
      scheduleAutosave();
    };
    if (o.type === 'room') {
      dimRows.push(ctxLenInput('Width',  () => o.w, commitBound('w')));
      dimRows.push(ctxLenInput('Height', () => o.h, commitBound('h')));
    } else if (o.type === 'door' || o.type === 'window') {
      dimRows.push(ctxLenInput('Width', () => o.w, (m) => {
        if (o.locked) return;
        pushHistory();
        o.w = Math.max(0.3, m);
        draw();
        refreshLayers();
        scheduleAutosave();
      }));
      // Quick angle presets — 0° / 90° / 180° / 270°
      dimRows.push(ctxAnglePresets(o));
      // Flip the swing direction (mirror about the opening's end-point).
      // Same effect as double-clicking the door/window.
      dimRows.push(ctxFlipRow(o));
    } else if (o.type === 'wall') {
      dimRows.push(ctxLenInput('Thickness',
        () => o.thickness || state.defaultWallThickness,
        (m) => {
          if (o.locked) return;
          pushHistory();
          o.thickness = Math.max(0.01, m);
          state.defaultWallThickness = o.thickness;
          draw();
          refreshLayers();
          scheduleAutosave();
        }
      ));
    }
    if (dimRows.length) {
      frag.appendChild(ctxSep());
      dimRows.forEach(r => frag.appendChild(r));
    }

    if (supportsFill || supportsStroke) frag.appendChild(ctxSep());

    if (supportsFill) {
      frag.appendChild(ctxSection('Fill'));
      frag.appendChild(ctxSwatchRow(FILL_SWATCHES, o.fill, (hex) => {
        pushHistory();
        o.fill = hex;
        refreshAll();
        scheduleAutosave();
      }));
    }
    if (supportsStroke) {
      frag.appendChild(ctxSection('Border'));
      frag.appendChild(ctxSwatchRow(STROKE_SWATCHES, o.stroke, (hex) => {
        pushHistory();
        o.stroke = hex;
        refreshAll();
        scheduleAutosave();
      }));
    }
    if (supportsOutline) {
      const row = document.createElement('div');
      row.className = 'ctx-section-row';
      const label = document.createElement('span');
      label.className = 'ctx-section ctx-inline-section';
      label.textContent = 'Border Thickness';
      row.appendChild(label);
      row.appendChild(ctxStepper(
        () => o.strokeWidth || 2,
        (v) => {
          pushHistory();
          o.strokeWidth = v;
          draw();
          refreshLayers();
          scheduleAutosave();
        },
        { min: 1, max: 20, step: 1 }
      ));
      frag.appendChild(row);
    }

    return frag;
  }

  function buildEmptyMenu() {
    const frag = document.createDocumentFragment();
    // Quick-action icon row: Undo / Redo
    frag.appendChild(ctxIconRow([
      { iconId: 'i-undo', title: 'Undo (Ctrl+Z)', shortcut: 'Undo', onClick: undo, disabled: state.history.length === 0 },
      { iconId: 'i-redo', title: 'Redo (Ctrl+Y)', shortcut: 'Redo', onClick: redo, disabled: state.future.length === 0 },
    ]));
    frag.appendChild(ctxSep());
    frag.appendChild(ctxZoomRow());
    frag.appendChild(ctxSep());
    frag.appendChild(ctxSection('Display'));
    ctxDisplayToggles(frag);
    return frag;
  }

  function showContextMenu(clientX, clientY, content) {
    if (!ctxMenu) return;
    ctxMenu.innerHTML = '';
    ctxMenu.appendChild(content);
    ctxMenu.hidden = false;
    ctxMenu.setAttribute('aria-hidden', 'false');
    // Position, then clamp to viewport on next frame once dimensions are known
    ctxMenu.style.left = `${clientX}px`;
    ctxMenu.style.top = `${clientY}px`;
    requestAnimationFrame(() => {
      const r = ctxMenu.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let nx = clientX, ny = clientY;
      if (r.right > vw - 6) nx = Math.max(6, vw - r.width - 6);
      if (r.bottom > vh - 6) ny = Math.max(6, vh - r.height - 6);
      ctxMenu.style.left = `${nx}px`;
      ctxMenu.style.top = `${ny}px`;
    });
  }

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const w = screenToWorld(sx, sy);
    const hit = hitTest(w.x, w.y);
    const content = hit ? buildObjectMenu(hit) : buildEmptyMenu();
    showContextMenu(e.clientX, e.clientY, content);
  });

  // Dismiss on outside interaction
  document.addEventListener('mousedown', (e) => {
    if (ctxMenu.hidden) return;
    if (!ctxMenu.contains(e.target)) hideContextMenu();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctxMenu.hidden) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  canvas.addEventListener('wheel', hideContextMenu, { passive: true });

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
  document.getElementById('btn-delete').addEventListener('click', deleteSelected);

  document.getElementById('btn-zoom-in-bar').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btn-zoom-out-bar').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('btn-zoom-reset-bar').addEventListener('click', resetView);

  // Generic dropdown wiring shared by Settings / Export / etc.
  // Toggles `panel.hidden`, mirrors `.open` on the wrapper, syncs aria,
  // and closes on outside click or Esc. Items inside the panel that have
  // `[data-close-on-click]` (set by default for `.dropdown-item`) close
  // the panel automatically when clicked.
  function bindDropdown(wrapId, btnId, panelId) {
    const wrap = document.getElementById(wrapId);
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!wrap || !btn || !panel) return;
    const close = () => {
      panel.hidden = true;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      panel.hidden = false;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.hidden ? open() : close();
    });
    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.dropdown-item');
      if (item) close();
    });
    document.addEventListener('mousedown', (e) => {
      if (panel.hidden) return;
      if (!wrap.contains(e.target)) close();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
  }

  bindDropdown('settings-dropdown', 'btn-settings', 'settings-panel');
  bindDropdown('file-dropdown', 'btn-file', 'file-panel');

  // Project name input \u2014 keep state in sync.
  (() => {
    const pn = document.getElementById('project-name');
    if (!pn) return;
    pn.value = state.projectName;
    sizeProjectNameInput();
    pn.addEventListener('input', () => {
      state.projectName = pn.value;
      sizeProjectNameInput();
      scheduleAutosave();
    });
    // Blur normalizes blank to placeholder default and renames the disk file
    // to match (when one is bound and the browser supports handle.move()).
    pn.addEventListener('blur', () => {
      if (!pn.value.trim()) {
        state.projectName = 'Untitled Layout';
        pn.value = state.projectName;
      }
      sizeProjectNameInput();
      scheduleAutosave();
      renameBoundFileToProject();
    });
    pn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); pn.blur(); }
    });
  })();

  // Cross-browser content-fit for the project-name input.
  // Chromium uses CSS `field-sizing: content`; Firefox / Safari fall back to
  // measuring the rendered text width here so the .json suffix sits flush.
  function sizeProjectNameInput() {
    const pn = document.getElementById('project-name');
    if (!pn) return;
    // Skip the JS sizing when the browser handles it natively.
    if (CSS && CSS.supports && CSS.supports('field-sizing', 'content')) return;
    const text = pn.value || pn.placeholder || '';
    const cs = window.getComputedStyle(pn);
    const c = sizeProjectNameInput._c
      || (sizeProjectNameInput._c = document.createElement('canvas').getContext('2d'));
    c.font = `${cs.fontStyle || 'normal'} ${cs.fontVariant || 'normal'} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = c.measureText(text).width;
    // Add a small caret allowance, clamp between min/max.
    pn.style.width = `${Math.max(48, Math.min(320, Math.ceil(w) + 6))}px`;
  }

  // Rename the bound file on disk so its name matches the project title.
  // Uses FileSystemFileHandle.move(newName) \u2014 Chromium 110+, same-directory
  // rename only. No-op when there's no bound file or the API is missing.
  async function renameBoundFileToProject() {
    if (!currentFile.handle || typeof currentFile.handle.move !== 'function') return;
    const m = currentFile.name && currentFile.name.match(/\.[^.]+$/);
    const ext = m ? m[0].replace(/^\./, '') : 'json';
    const desired = exportFilename(ext);
    if (desired === currentFile.name) return;
    try {
      const ok = await ensureWritePermission(currentFile.handle);
      if (!ok) return;
      await currentFile.handle.move(desired);
      currentFile.name = desired;
      persistHandle(currentFile.handle, desired, lastSavedAt || Date.now(), activeTabId);
      updateFileMeta();
      flash(`Renamed to ${desired}`);
    } catch (err) {
      console.warn('Could not rename file on disk', err);
      flash('Could not rename file on disk');
    }
  }

  // After opening a file, set the editable project title (and underlying
  // state) to match the file's base name so the on-disk name is the source
  // of truth. Strips the extension; falls back to existing project name if
  // the file name has no base.
  function syncProjectNameToFile(fileName) {
    if (!fileName) return;
    const base = fileName.replace(/\.[^.]+$/, '').trim();
    if (!base) return;
    state.projectName = base;
    const pn = document.getElementById('project-name');
    if (pn) pn.value = base;
    if (typeof sizeProjectNameInput === 'function') sizeProjectNameInput();
  }

  // ---------- Open / Save to a file on the user's computer ----------
  // Uses the File System Access API (Chromium) when available so subsequent
  // Saves write back to the same file without re-prompting. On other
  // browsers (Firefox/Safari) we fall back to a hidden <input type=file>
  // for Open and a download for Save / Save As.
  const hasFSAccess =
    typeof window !== 'undefined' &&
    'showOpenFilePicker' in window &&
    'showSaveFilePicker' in window;

  // Currently bound file (null until the user opens or saves one).
  // Currently bound file for the active tab. Reassigned on tab switch.
  let currentFile = { handle: null, name: null };

  const FILE_PICKER_TYPES = [{
    description: 'Khaaka Layout (JSON)',
    accept: { 'application/json': ['.json'] },
  }];

  // ---------- Persist the FileSystemFileHandle across reloads ----------
  // Handles are structured-cloneable so we can stash them in IndexedDB.
  // localStorage cannot hold them. On reload we restore { handle, name } but
  // permission must be re-granted on a user gesture (browser security rule).
  // Records are now keyed per tab id so multiple tabs persist independently.
  const HANDLE_DB = 'khaaka-fs';
  const HANDLE_STORE = 'handles';

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function persistHandle(handle, name, savedAt, tabId) {
    if (!hasFSAccess) return;
    const key = tabId || (activeTab() && activeTab().id) || 'currentFile';
    try {
      const db = await openHandleDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).put({ handle, name, savedAt: savedAt || Date.now() }, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (err) {
      console.warn('Could not persist file handle', err);
    }
  }
  async function clearPersistedHandle(tabId) {
    const key = tabId || (activeTab() && activeTab().id) || 'currentFile';
    try {
      const db = await openHandleDb();
      await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, 'readwrite');
        tx.objectStore(HANDLE_STORE).delete(key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch { /* ignore */ }
  }
  async function loadPersistedHandle(tabId) {
    if (!hasFSAccess) return null;
    const key = tabId || 'currentFile';
    try {
      const db = await openHandleDb();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction(HANDLE_STORE, 'readonly');
        const r = tx.objectStore(HANDLE_STORE).get(key);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return rec;
    } catch { return null; }
  }

  // ---------- Tabs (multi-document) ----------
  // Each tab owns: state, currentFile, lastSavedFileSnapshot, lastSavedAt.
  // The module-level `state` and `currentFile` always point at the active
  // tab so the rest of the app keeps working unchanged.
  const tabs = [];
  let activeTabId = null;
  function activeTab() {
    return tabs.find(t => t.id === activeTabId) || null;
  }
  function makeTabId() {
    return 't_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
  }
  function makeTab(opts = {}) {
    return {
      id: opts.id || makeTabId(),
      state: opts.state || makeBlankState(),
      currentFile: opts.currentFile || { handle: null, name: null },
      lastSavedFileSnapshot: opts.lastSavedFileSnapshot || null,
      lastSavedAt: opts.lastSavedAt || null,
    };
  }
  function snapshotActiveTab() {
    const t = activeTab();
    if (!t) return;
    t.state = state;
    t.currentFile = currentFile;
    t.lastSavedFileSnapshot = lastSavedFileSnapshot;
    t.lastSavedAt = lastSavedAt;
  }
  function hydrateTab(t) {
    state = t.state;
    currentFile = t.currentFile;
    lastSavedFileSnapshot = t.lastSavedFileSnapshot;
    lastSavedAt = t.lastSavedAt;
  }

  // Push the active tab's state into the UI (project name, units, grid
  // toggles, tool selection). Caller is responsible for the canvas redraw.
  function syncUIFromState() {
    const pn = document.getElementById('project-name');
    if (pn) pn.value = state.projectName;
    if (typeof sizeProjectNameInput === 'function') sizeProjectNameInput();
    const optGrid = document.getElementById('opt-grid');
    if (optGrid) optGrid.checked = !!state.grid.show;
    const optSnap = document.getElementById('opt-snap');
    if (optSnap) optSnap.checked = !!state.grid.snap;
    const optDims = document.getElementById('opt-dims');
    if (optDims) optDims.checked = !!state.showDims;
    const optUnits = document.getElementById('opt-units');
    if (optUnits) optUnits.value = state.units;
    const optBoxPx = document.getElementById('opt-box-px');
    if (optBoxPx) optBoxPx.value = String(state.pxPerBox);
    document.querySelectorAll('.tool[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === state.tool);
    });
    if (typeof refreshUnitLabels === 'function') refreshUnitLabels();
  }

  function switchToTab(id) {
    if (id === activeTabId) { renderTabStrip(); return; }
    snapshotActiveTab();
    const next = tabs.find(t => t.id === id);
    if (!next) return;
    activeTabId = id;
    hydrateTab(next);
    syncUIFromState();
    if (typeof refreshAll === 'function') refreshAll();
    updateFileMeta();
    if (typeof updateSaveButton === 'function') updateSaveButton();
    renderTabStrip();
    persistTabs();
  }

  function createTab(opts = {}) {
    snapshotActiveTab();
    const t = makeTab(opts);
    tabs.push(t);
    if (opts.activate !== false) {
      activeTabId = t.id;
      hydrateTab(t);
      syncUIFromState();
      if (typeof refreshAll === 'function') refreshAll();
      updateFileMeta();
      if (typeof updateSaveButton === 'function') updateSaveButton();
    }
    renderTabStrip();
    persistTabs();
    return t;
  }

  async function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    if (id === activeTabId) snapshotActiveTab();
    const t = tabs[i];
    const dirty = isTabDirty(t);
    if (dirty) {
      if (id !== activeTabId) switchToTab(id);
      const choice = await showModal({
        kind: 'confirm',
        title: 'Close this file?',
        message: `"${t.currentFile.name || (t.state.projectName + '.json')}" has unsaved changes. Save before closing, or discard them.`,
        okText: 'Save & close',
        extraText: 'Discard & close',
        cancelText: 'Cancel',
      });
      if (choice === false) return;     // Cancel / Esc / backdrop
      if (choice === true) {
        try {
          if (currentFile.handle) await saveToFile();
          else await saveAsToFile();
        } catch (err) {
          flash('Could not save — close cancelled');
          return;
        }
      }
    }
    clearPersistedHandle(t.id);
    const wasActive = id === activeTabId;
    tabs.splice(i, 1);
    if (wasActive) {
      const neighbor = tabs[i] || tabs[i - 1];
      if (neighbor) {
        activeTabId = neighbor.id;
        hydrateTab(neighbor);
      } else {
        const fresh = makeTab();
        tabs.push(fresh);
        activeTabId = fresh.id;
        hydrateTab(fresh);
      }
      syncUIFromState();
      refreshAll();
      updateFileMeta();
      updateSaveButton();
    }
    renderTabStrip();
    persistTabs();
  }

  // Stable serialization used for dirty checks and persistence.
  function serializeState(s) {
    return JSON.stringify({
      version: 1,
      pxPerMeter: s.pxPerMeter, pxPerBox: s.pxPerBox,
      grid: s.grid, showDims: s.showDims, units: s.units,
      defaultWallThickness: s.defaultWallThickness,
      projectName: s.projectName,
      view: s.view, objects: s.objects, nextId: s.nextId,
    }, null, 2);
  }
  function isTabDirty(t) {
    const s = (t.id === activeTabId) ? state : t.state;
    const cf = (t.id === activeTabId) ? currentFile : t.currentFile;
    const last = (t.id === activeTabId) ? lastSavedFileSnapshot : t.lastSavedFileSnapshot;
    if (!cf || !cf.name) return false;
    return serializeState(s) !== last;
  }

  function persistTabs() {
    try {
      const list = tabs.map(t => {
        const s = (t.id === activeTabId) ? state : t.state;
        const cf = (t.id === activeTabId) ? currentFile : t.currentFile;
        return {
          id: t.id,
          fileName: cf && cf.name || null,
          snap: serializeState(s),
        };
      });
      localStorage.setItem(TABS_KEY, JSON.stringify(list));
      localStorage.setItem(ACTIVE_TAB_KEY, activeTabId || '');
    } catch (err) {
      console.warn('Could not persist tabs', err);
    }
  }

  // Restore tabs from localStorage + IDB. Returns true if at least one tab
  // was hydrated; false if there was nothing to restore.
  async function restoreTabs() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(TABS_KEY) || '[]'); } catch { list = []; }
    const activeStored = localStorage.getItem(ACTIVE_TAB_KEY) || '';
    if (list.length === 0) {
      // Migration from the legacy single-tab key.
      const legacy = localStorage.getItem(STORAGE_KEY);
      if (legacy) list = [{ id: makeTabId(), fileName: null, snap: legacy }];
    }
    if (list.length === 0) return false;

    for (const rec of list) {
      const t = makeTab({ id: rec.id });
      try {
        const d = JSON.parse(rec.snap);
        Object.assign(t.state, {
          objects: d.objects || [],
          nextId: d.nextId || (Math.max(0, ...((d.objects || []).map(o => o.id))) + 1),
          pxPerMeter: d.pxPerMeter || 40,
          pxPerBox: d.pxPerBox || 25,
          grid: d.grid || t.state.grid,
          showDims: d.showDims !== undefined ? d.showDims : true,
          units: d.units === 'ft' ? 'ft' : 'm',
          defaultWallThickness: typeof d.defaultWallThickness === 'number' ? d.defaultWallThickness : t.state.defaultWallThickness,
          projectName: typeof d.projectName === 'string' && d.projectName.trim() ? d.projectName : t.state.projectName,
          view: d.view && typeof d.view.zoom === 'number' ? {
            x: typeof d.view.x === 'number' ? d.view.x : 0,
            y: typeof d.view.y === 'number' ? d.view.y : 0,
            zoom: Math.max(0.1, Math.min(8, d.view.zoom)),
          } : t.state.view,
        });
        t.lastSavedFileSnapshot = rec.snap;
      } catch (err) {
        console.warn('Could not restore tab snapshot', err);
      }
      // Re-attach the file handle (Chromium FS Access only).
      const handleRec = await loadPersistedHandle(t.id);
      if (handleRec && handleRec.handle) {
        t.currentFile = { handle: handleRec.handle, name: handleRec.name || rec.fileName || null };
        t.lastSavedAt = handleRec.savedAt || null;
      } else if (rec.fileName) {
        t.currentFile = { handle: null, name: rec.fileName };
      }
      tabs.push(t);
    }
    const activeRec = tabs.find(t => t.id === activeStored) || tabs[0];
    activeTabId = activeRec.id;
    hydrateTab(activeRec);
    return true;
  }

  function renderTabStrip() {
    const list = document.getElementById('tab-list');
    if (!list) return;
    list.innerHTML = '';
    for (const t of tabs) {
      const isActive = t.id === activeTabId;
      const cf = isActive ? currentFile : t.currentFile;
      const s = isActive ? state : t.state;
      const dirty = isTabDirty(t);
      const el = document.createElement('div');
      el.className = 'tab' + (isActive ? ' active' : '') + (dirty ? ' dirty' : '');
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(isActive));
      const label = cf.name || `${s.projectName || 'Untitled'}.json`;
      el.title = label;
      el.innerHTML =
        `<span class="tab-name">${escapeHtml(label)}</span>` +
        `<span class="tab-dirty" aria-hidden="true"></span>` +
        `<button class="tab-close" type="button" title="Close" aria-label="Close tab">` +
          `<svg class="ic"><use href="#i-x"/></svg>` +
        `</button>`;
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('.tab-close')) return;
        switchToTab(t.id);
      });
      el.querySelector('.tab-close').addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(t.id);
      });
      list.appendChild(el);
    }
  }

  function updateFileMeta() {
    const el = document.getElementById('file-name');
    if (el) {
      if (currentFile.name) {
        if (lastSavedAt) {
          el.innerHTML = `Saved at <span class="saved-at">${formatSavedAt(lastSavedAt)}</span>`;
        } else {
          el.textContent = 'Saved';
        }
        el.classList.add('has-file');
        el.title = currentFile.name + (lastSavedAt ? ` — saved ${new Date(lastSavedAt).toLocaleString()}` : '');
      } else {
        el.textContent = 'Unsaved';
        el.classList.remove('has-file');
        el.title = 'No file opened — use File ▸ Save File As… to save to disk';
      }
      // Reflect dirty state (compare current snapshot to last file save)
      const dirty = currentFile.name && lastSavedFileSnapshot !== serialize();
      el.classList.toggle('dirty', !!dirty);
    }
    // Mirror the bound file's extension on the editable title (default .json)
    const ext = document.getElementById('ext-suffix');
    if (ext) {
      const m = currentFile.name && currentFile.name.match(/\.[^.]+$/);
      ext.textContent = m ? m[0].toLowerCase() : '.json';
    }
    if (typeof updateSaveButton === 'function') updateSaveButton();
  }

  // Snapshot of the layout the last time it was successfully written to a file.
  let lastSavedFileSnapshot = null;
  // Epoch millis of the last successful disk save (persisted with the handle).
  let lastSavedAt = null;

  // "Saved as … at <time> (<relative>)"
  // Examples:
  //   "10:42 AM (3 sec ago)"
  //   "10:42 AM (5 min ago)"
  //   "yesterday at 10:42 AM"
  //   "May 10, 10:42 AM"
  function formatSavedAt(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return `${time} (${formatRelative(now - d)})`;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate();
    if (isYesterday) return `yesterday at ${time}`;
    const datePart = d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
    return `${datePart}, ${time}`;
  }

  function formatRelative(diffMs) {
    const sec = Math.max(0, Math.floor(diffMs / 1000));
    if (sec < 60) return `${sec} sec ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    return `${hr} hr ago`;
  }

  // Refresh the relative label every second so "3 sec ago" stays live.
  // Slows to 30s once it's older than a minute (no point updating per-second).
  setInterval(() => {
    if (!lastSavedAt || !currentFile.name) return;
    const ageSec = (Date.now() - lastSavedAt) / 1000;
    if (ageSec < 60) updateFileMeta();
    else if (ageSec < 3600 && Math.floor(ageSec) % 30 === 0) updateFileMeta();
  }, 1000);

  async function ensureWritePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return true;
    const opts = { mode: 'readwrite' };
    let p = await handle.queryPermission(opts);
    if (p === 'granted') return true;
    p = await handle.requestPermission(opts);
    return p === 'granted';
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('Read failed'));
      r.readAsText(file);
    });
  }

  async function openFromFile() {
    // Always opens into a NEW tab. Current tab stays untouched.
    try {
      if (hasFSAccess) {
        let handle;
        try {
          [handle] = await window.showOpenFilePicker({
            types: FILE_PICKER_TYPES,
            excludeAcceptAllOption: false,
            multiple: false,
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user cancelled
          throw err;
        }
        const file = await handle.getFile();
        const text = await file.text();
        // Spawn a fresh tab and load into it.
        createTab();
        if (deserialize(text)) {
          currentFile.handle = handle;
          currentFile.name = file.name;
          syncProjectNameToFile(file.name);
          lastSavedFileSnapshot = serialize();
          lastSavedAt = (file.lastModified || Date.now());
          persistHandle(handle, file.name, lastSavedAt, activeTabId);
          updateFileMeta();
          renderTabStrip();
          persistTabs();
          flash(`Opened ${file.name}`);
        }
      } else {
        // Fallback: trigger the hidden file input
        document.getElementById('file-open-fallback').click();
      }
    } catch (err) {
      console.error(err);
      flash('Open failed');
    }
  }

  async function saveAsToFile() {
    try {
      if (hasFSAccess) {
        let handle;
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: exportFilename('json'),
            types: FILE_PICKER_TYPES,
          });
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          throw err;
        }
        const text = serialize();
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        currentFile.handle = handle;
        currentFile.name = handle.name || exportFilename('json');
        lastSavedFileSnapshot = text;
        lastSavedAt = Date.now();
        persistHandle(handle, currentFile.name, lastSavedAt, activeTabId);
        updateFileMeta();
        flash(`Saved to ${currentFile.name}`);
      } else {
        // Fallback: just trigger a download
        const name = exportFilename('json');
        download(name, serialize(), 'application/json');
        currentFile.handle = null;
        currentFile.name = name;
        lastSavedFileSnapshot = serialize();
        lastSavedAt = Date.now();
        updateFileMeta();
        flash(`Downloaded ${name}`);
      }
    } catch (err) {
      console.error(err);
      flash('Save failed');
    }
  }

  async function saveToFile() {
    // No bound file yet → behave as Save As.
    if (!currentFile.handle) return saveAsToFile();
    try {
      const ok = await ensureWritePermission(currentFile.handle);
      if (!ok) {
        flash('Permission denied — choose a location');
        return saveAsToFile();
      }
      const text = serialize();
      const w = await currentFile.handle.createWritable();
      await w.write(text);
      await w.close();
      lastSavedFileSnapshot = text;
      lastSavedAt = Date.now();
      persistHandle(currentFile.handle, currentFile.name, lastSavedAt, activeTabId);
      updateFileMeta();
      flash(`Saved to ${currentFile.name}`);
    } catch (err) {
      console.error(err);
      // If the handle is no longer valid (file was moved/deleted) prompt for a new one.
      if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
        currentFile.handle = null;
        return saveAsToFile();
      }
      flash('Save failed');
    }
  }

  document.getElementById('btn-open-file').addEventListener('click', openFromFile);
  document.getElementById('btn-save-file').addEventListener('click', saveToFile);
  document.getElementById('btn-save-as-file').addEventListener('click', saveAsToFile);
  document.getElementById('btn-export-png').addEventListener('click', exportPNG);
  document.getElementById('btn-save').addEventListener('click', () => {
    // No bound file → prompt user to choose a destination.
    // Otherwise just write back to the existing file.
    if (currentFile.handle || (!hasFSAccess && currentFile.name)) {
      saveToFile();
    } else {
      saveAsToFile();
    }
  });

  // Fallback open input (used on browsers without File System Access API)
  document.getElementById('file-open-fallback').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      // Open into a new tab.
      createTab();
      if (deserialize(text)) {
        currentFile.handle = null;       // no handle on fallback
        currentFile.name = file.name;
        syncProjectNameToFile(file.name);
        lastSavedFileSnapshot = serialize();
        lastSavedAt = (file.lastModified || Date.now());
        updateFileMeta();
        renderTabStrip();
        persistTabs();
        flash(`Opened ${file.name}`);
      }
    } catch (err) {
      flash('Open failed');
    }
  });

  // "+" button on the tab strip → blank new tab.
  document.getElementById('tab-add').addEventListener('click', () => {
    createTab();
  });

  // Canvas option inputs
  document.getElementById('opt-units').addEventListener('change', (e) => {
    state.units = e.target.value === 'ft' ? 'ft' : 'm';
    // Reset to the canonical default box size for the chosen unit system
    // (1' for feet/inches, 25 cm for meters) instead of converting the
    // previous value to the nearest option.
    state.grid.size = state.units === 'ft' ? ftToM(1) : 0.25;
    applyPxPerBox();
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

  function refreshUnitLabels() {
    document.getElementById('opt-grid-size-label').textContent =
      state.units === 'ft' ? 'Box size (ft)' : 'Box size (m)';
    populateGridSizeOptions();
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
      if (k === 'o') { e.preventDefault(); openFromFile(); return; }
      if (k === 's') {
        e.preventDefault();
        if (e.shiftKey) { saveAsToFile(); return; }
        // If a file is currently bound, Ctrl+S writes back to it; otherwise
        // open the Save File dialog so the user can pick a destination.
        if (currentFile.handle || (!hasFSAccess && currentFile.name)) {
          saveToFile();
        } else {
          saveAsToFile();
        }
        return;
      }
      if (k === 'n') { e.preventDefault(); createTab(); return; }
      if (k === 't') { e.preventDefault(); createTab(); return; }
      if (k === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); return; }
    }
    const map = { v: 'select', r: 'room', w: 'wall', d: 'door', n: 'window', t: 'text', m: 'measure' };
    if (map[e.key.toLowerCase()]) {
      const tool = map[e.key.toLowerCase()];
      const btn = document.querySelector(`.tool[data-tool="${tool}"]`);
      if (btn) btn.click();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelected();
    } else if (e.key === 'F2') {
      e.preventDefault();
      renameSelected();
    } else if (e.key === '+' || e.key === '=') { zoomBy(1.2); }
    else if (e.key === '-') { zoomBy(1 / 1.2); }
    else if (e.key === '0') { resetView(); }
  });

  // Start inline rename on the selected object via the Layers panel.
  // Switches to the object's layer category tab if needed so the row exists,
  // then triggers the same rename UI used by double-click.
  function renameSelected() {
    if (state.selectedId == null) { flash('Select an object first'); return; }
    const o = state.objects.find(x => x.id === state.selectedId);
    if (!o) return;
    if (o.type === 'measure') { flash('Measurements have no name'); return; }
    // Switch to the matching tab so the row gets rendered
    if (activeLayerTab !== o.type) {
      activeLayerTab = o.type;
      refreshLayers();
    }
    // Find the row and trigger its double-click rename
    const li = document.querySelector(`#layer-list li.layer-item[data-id="${o.id}"]`);
    if (!li) return;
    const nameSpan = li.querySelector('.layer-name');
    if (!nameSpan) return;
    startInlineRename(li, nameSpan, o);
  }

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
  // The Properties panel was removed - all editing flows through the
  // right-click context menu, the Layers panel, and direct canvas
  // manipulation. `refreshProps` is kept as a no-op so existing call
  // sites (mouse/keyboard handlers, undo/redo, etc.) do not change.
  function refreshProps() {}

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

    // Hide the entire Layers card when the layout has no objects at all.
    const layersCard = document.getElementById('layers-card');
    if (layersCard) layersCard.hidden = state.objects.length === 0;
    if (state.objects.length === 0) {
      if (layerTabs) layerTabs.innerHTML = '';
      if (layerList) layerList.innerHTML = '';
      return;
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
    refreshSidePanel();
    draw();
    scheduleAutosave();
  }

  // Hide the entire right-side panel when there are no objects (Layers card
  // is empty). Properties card was removed; only Layers lives here now.
  function refreshSidePanel() {
    const aside = document.querySelector('aside.properties');
    const layersCard = document.getElementById('layers-card');
    if (!aside) return;
    aside.hidden = !(layersCard && !layersCard.hidden);
  }

  // ---------- Autosave (debounced) ----------
  // Saves the current layout to localStorage shortly after any state change,
  // so the user never loses work if they close the tab. When a real file is
  // bound (File ▸ Open / Save As), also write that file silently.
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
      localStorage.setItem(STORAGE_KEY, snap);  // legacy mirror
      lastSavedSnapshot = snap;
    } catch (err) {
      // Storage may be full or unavailable (private mode, quota, etc.)
      flash('Auto-save failed');
    }
    // Mirror to disk when a file handle is bound.
    if (currentFile.handle) autosaveToDisk();
    updateFileMeta();
    updateSaveButton();
    // Multi-tab: persist all tab snapshots + dirty state on the strip.
    persistTabs();
    renderTabStrip();
  }

  // Coalescing disk-writer: at most one in-flight write at a time. If new
  // changes arrive mid-write, queue exactly one follow-up write.
  let diskWriteInFlight = false;
  let diskWritePending = false;
  async function autosaveToDisk() {
    if (!currentFile.handle) return;
    if (diskWriteInFlight) { diskWritePending = true; return; }
    diskWriteInFlight = true;
    try {
      const text = serialize();
      const ok = await ensureWritePermission(currentFile.handle);
      if (!ok) { diskWriteInFlight = false; return; }
      const w = await currentFile.handle.createWritable();
      await w.write(text);
      await w.close();
      lastSavedFileSnapshot = text;
      lastSavedAt = Date.now();
      persistHandle(currentFile.handle, currentFile.name, lastSavedAt, activeTabId);
      updateFileMeta();
      updateSaveButton();
    } catch (err) {
      console.warn('Disk autosave failed', err);
      // If the handle vanished (file was moved/deleted), drop it so the user
      // is prompted to choose a new location on the next manual save.
      if (err && (err.name === 'NotFoundError' || err.name === 'NotAllowedError')) {
        currentFile.handle = null;
        currentFile.name = null;
        lastSavedFileSnapshot = null;
        lastSavedAt = null;
        clearPersistedHandle(activeTabId);
        updateFileMeta();
        updateSaveButton();
        flash('File no longer accessible — Save again to pick a new location');
      }
    } finally {
      diskWriteInFlight = false;
      if (diskWritePending) {
        diskWritePending = false;
        // Run the queued follow-up after current micro-task settles.
        Promise.resolve().then(autosaveToDisk);
      }
    }
  }

  // Heartbeat: every second, re-write the bound file even if nothing changed.
  // Touches the file's modification time and refreshes "Saved at <time>".
  // The coalescing guard above ensures we never have overlapping writes.
  setInterval(() => {
    if (currentFile.handle && !suppressAutosave) autosaveToDisk();
  }, 1000);

  // Save-button state. Behaviour:
  //  • No file bound  → enabled "Save" → opens Save As dialog
  //  • File bound + on-disk in sync → disabled "Saved"
  //  • File bound + autosave in flight → still shows "Saved" (silent autosave;
  //    avoids flicker between Saved → Saving… → Saved on every edit)
  function updateSaveButton() {
    const btn = document.getElementById('btn-save');
    if (!btn) return;
    const labelEl = btn.querySelector('span');
    const hasFile = !!currentFile.handle || (!hasFSAccess && !!currentFile.name);
    const inSync = hasFile && lastSavedFileSnapshot === serialize();
    const saving = diskWriteInFlight || diskWritePending;

    let label, disabled, title;
    if (!hasFile) {
      label = 'Save'; disabled = false; title = 'Save to file (Ctrl+S)';
    } else if (inSync || saving) {
      // Treat in-flight autosave as already saved — the bytes are on the way
      // and the user shouldn't see a busy state for routine edits.
      label = 'Saved'; disabled = true; title = 'All changes saved to file';
    } else {
      label = 'Save'; disabled = false; title = 'Save to file (Ctrl+S)';
    }
    btn.disabled = disabled;
    btn.classList.toggle('is-saved', disabled && hasFile);
    if (labelEl) labelEl.textContent = label;
    btn.title = title;
  }

  // Track snapshot of the last successful localStorage save (used by
  // updateFileMeta dirty comparison).
  let lastSavedSnapshot = null;
  // Best-effort flush before leaving the page
  window.addEventListener('beforeunload', (e) => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      try { localStorage.setItem(STORAGE_KEY, serialize()); } catch {}
      // Disk write is async and may not finish before unload; warn the user
      // if there are unsaved changes to a bound file.
      if (currentFile.handle && lastSavedFileSnapshot !== serialize()) {
        e.preventDefault();
        e.returnValue = '';
      }
    } else if (currentFile.handle && lastSavedFileSnapshot !== serialize()) {
      e.preventDefault();
      e.returnValue = '';
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
      view: { x: state.view.x, y: state.view.y, zoom: state.view.zoom },
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
      state.pxPerBox = d.pxPerBox || 25;
      state.grid = d.grid || state.grid;
      state.showDims = d.showDims !== undefined ? d.showDims : true;
      state.units = d.units === 'ft' ? 'ft' : 'm';
      if (typeof d.defaultWallThickness === 'number') state.defaultWallThickness = d.defaultWallThickness;
      if (typeof d.projectName === 'string' && d.projectName.trim()) state.projectName = d.projectName;
      if (d.view && typeof d.view.zoom === 'number') {
        state.view = {
          x: typeof d.view.x === 'number' ? d.view.x : state.view.x,
          y: typeof d.view.y === 'number' ? d.view.y : state.view.y,
          zoom: Math.max(0.1, Math.min(8, d.view.zoom)),
        };
      }
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
      showModal({
        kind: 'alert',
        title: 'Could not load layout',
        message: err.message,
      });
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

  // Build a safe export filename from the project name.
  // Returns e.g. "My Plot.json". The user can rename in the save dialog.
  function exportFilename(ext) {
    const raw = (state.projectName || 'Untitled Layout').trim() || 'Untitled Layout';
    // Strip characters that are invalid in filenames on Windows/macOS/Linux.
    const safe = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').slice(0, 60).trim() || 'Untitled Layout';
    return `${safe}.${ext}`;
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

  // ---------- Modal dialog (custom alert / confirm / prompt) ----------
  // Returns a Promise resolving to:
  //   - alert:   true / false  (always true once dismissed; hitting Esc/cancel returns false)
  //   - confirm: true / false  (true on OK, false on Cancel/Esc)
  //   - prompt:  string / null (null on Cancel/Esc, string on OK)
  // opts: { title, message, kind: 'alert'|'confirm'|'prompt', okText, cancelText,
  //         danger, defaultValue, placeholder }
  function showModal(opts = {}) {
    const backdrop = document.getElementById('modal-backdrop');
    const titleEl = document.getElementById('modal-title');
    const msgEl   = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const okBtn   = document.getElementById('modal-ok');
    const cancelBtn = document.getElementById('modal-cancel');
    if (!backdrop) return Promise.resolve(false);

    const kind = opts.kind || 'alert';
    titleEl.textContent = opts.title || '';
    msgEl.textContent = opts.message || '';
    okBtn.textContent = opts.okText || (kind === 'alert' ? 'OK' : (kind === 'confirm' ? 'Confirm' : 'OK'));
    cancelBtn.textContent = opts.cancelText || 'Cancel';
    cancelBtn.hidden = (kind === 'alert');
    okBtn.classList.toggle('danger', !!opts.danger);

    // Optional middle button (e.g. "Discard & open"). Inserted between
    // Cancel and OK; resolves the promise with the string 'extra'.
    let extraBtn = document.getElementById('modal-extra');
    if (opts.extraText) {
      if (!extraBtn) {
        extraBtn = document.createElement('button');
        extraBtn.id = 'modal-extra';
        extraBtn.type = 'button';
        extraBtn.className = 'modal-btn modal-btn-ghost';
        cancelBtn.parentNode.insertBefore(extraBtn, okBtn);
      }
      extraBtn.textContent = opts.extraText;
      extraBtn.hidden = false;
    } else if (extraBtn) {
      extraBtn.hidden = true;
    }

    if (kind === 'prompt') {
      inputEl.hidden = false;
      inputEl.value = opts.defaultValue ?? '';
      inputEl.placeholder = opts.placeholder || '';
    } else {
      inputEl.hidden = true;
      inputEl.value = '';
    }

    backdrop.hidden = false;
    backdrop.setAttribute('aria-hidden', 'false');

    return new Promise(resolve => {
      const close = (result) => {
        backdrop.hidden = true;
        backdrop.setAttribute('aria-hidden', 'true');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (extraBtn) extraBtn.removeEventListener('click', onExtra);
        backdrop.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      };
      const onOk = () => {
        if (kind === 'prompt') close(inputEl.value);
        else if (kind === 'confirm') close(true);
        else close(true);
      };
      const onCancel = () => {
        if (kind === 'prompt') close(null);
        else close(false);
      };
      const onExtra = () => close('extra');
      const onBackdrop = (e) => { if (e.target === backdrop) onCancel(); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        else if (e.key === 'Enter' && document.activeElement !== cancelBtn) {
          // Allow Enter to confirm; in a prompt this also captures input value
          e.preventDefault(); e.stopPropagation(); onOk();
        }
      };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (extraBtn && opts.extraText) extraBtn.addEventListener('click', onExtra);
      backdrop.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      // Focus management
      setTimeout(() => {
        if (kind === 'prompt') { inputEl.focus(); inputEl.select(); }
        else okBtn.focus();
      }, 0);
    });
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

  // ---------- Custom tooltip controller ----------
  // Hijacks any element's `title` attribute and shows it as a polished
  // floating tooltip instead of the native browser one. The native title
  // is removed on hover (kept in `data-tip-cache` so it can be restored).
  // Anything with `data-tip="..."` works too \u2014 useful for elements where
  // the native title would interfere (e.g. screen reader labels).
  (() => {
    const tip = document.getElementById('tooltip');
    if (!tip) return;
    let target = null;
    let showTimer = null;
    const SHOW_DELAY = 280;   // ms before showing
    const SAFETY = 6;         // viewport edge padding
    const GAP = 8;            // distance from target

    const getTipText = (el) => {
      if (!el) return '';
      const cached = el.getAttribute('data-tip') || el.getAttribute('data-tip-cache');
      if (cached) return cached;
      const t = el.getAttribute('title');
      if (!t) return '';
      // Move title into our cache so the browser doesn't show its own.
      el.setAttribute('data-tip-cache', t);
      el.removeAttribute('title');
      return t;
    };

    // Render the text \u2014 promotes "(Ctrl+S)" / "(Del)" suffixes into a kbd chip.
    const renderText = (text) => {
      const m = text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      if (!m) { tip.textContent = text; return; }
      tip.textContent = '';
      tip.append(m[1].trim());
      const k = document.createElement('kbd');
      k.textContent = m[2].trim();
      tip.appendChild(k);
    };

    const place = (el) => {
      const r = el.getBoundingClientRect();
      // Default: above. Flip below if not enough room above.
      tip.removeAttribute('hidden');
      // Force layout so we can measure
      tip.style.left = '0px';
      tip.style.top = '0px';
      const tr = tip.getBoundingClientRect();
      let dir = 'above';
      let top = r.top - tr.height - GAP;
      if (top < SAFETY) {
        dir = 'below';
        top = r.bottom + GAP;
      }
      let left = r.left + r.width / 2 - tr.width / 2;
      // Clamp horizontally
      if (left < SAFETY) left = SAFETY;
      else if (left + tr.width > window.innerWidth - SAFETY) left = window.innerWidth - tr.width - SAFETY;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top  = `${Math.round(top)}px`;
      tip.setAttribute('data-dir', dir);
      // Position the arrow: keep it pointing at target's center
      const arrowX = (r.left + r.width / 2) - left;
      tip.style.setProperty('--tip-arrow-x', `${arrowX}px`);
      // Hide arrow if target is off-screen / too narrow to point cleanly
      tip.classList.toggle('no-arrow', r.width < 12 || r.height < 12);
    };

    const show = (el) => {
      const text = getTipText(el);
      if (!text) return;
      renderText(text);
      tip.hidden = false;
      tip.setAttribute('aria-hidden', 'false');
      place(el);
      // Trigger the entrance transition on the next frame
      requestAnimationFrame(() => tip.classList.add('show'));
      target = el;
    };

    const hide = () => {
      clearTimeout(showTimer);
      showTimer = null;
      tip.classList.remove('show');
      // Wait for fade-out before fully hiding
      setTimeout(() => {
        if (!tip.classList.contains('show')) {
          tip.hidden = true;
          tip.setAttribute('aria-hidden', 'true');
        }
      }, 120);
      target = null;
    };

    const findTarget = (el) => {
      while (el && el !== document.body) {
        if (el.nodeType === 1 && (el.hasAttribute('title') || el.hasAttribute('data-tip') || el.hasAttribute('data-tip-cache'))) {
          // Skip elements with empty tip text
          const text = el.getAttribute('data-tip') || el.getAttribute('data-tip-cache') || el.getAttribute('title');
          if (text && text.trim()) return el;
        }
        el = el.parentElement;
      }
      return null;
    };

    document.addEventListener('mouseover', (e) => {
      const el = findTarget(e.target);
      if (!el || el === target) return;
      // Cancel any pending show
      clearTimeout(showTimer);
      // If a tooltip is already showing, swap immediately
      if (target) hide();
      showTimer = setTimeout(() => show(el), SHOW_DELAY);
    });
    document.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (to && (tip.contains(to) || (target && target.contains(to)))) return;
      hide();
    });
    // Hide on user interactions that should reset hover state
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('blur', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  })();

  // ---------- Init ----------
  window.addEventListener('resize', resizeCanvas);
  // Redraw the canvas whenever its element resizes (e.g. the right side
  // panel hides/shows and the grid column collapses).
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resizeCanvas).observe(canvas);
  }
  resetView();
  resizeCanvas();
  refreshUnitLabels();
  initCollapsibleCards();

  // ---------- Multi-tab bootstrap ----------
  // Restore the saved tab list (handles via IDB, snapshots via localStorage,
  // legacy single-tab key migrated automatically). If nothing to restore,
  // start with a single empty tab — clean slate, no demo content.
  (async () => {
    const restored = await restoreTabs();
    if (!restored) {
      const t = makeTab();
      tabs.push(t);
      activeTabId = t.id;
      hydrateTab(t);
    }
    syncUIFromState();
    refreshAll();
    lastSavedSnapshot = serialize();
    updateFileMeta();
    updateSaveButton();
    renderTabStrip();
    persistTabs();
  })();

  // Polished default plot \u2014 a small 2-bedroom apartment using only the
  // palette colors. Demonstrates rooms, walls, doors, windows, text and a
  // measurement so the canvas isn't empty on first run.
  function seedSampleLayout() {
    state.projectName = 'Sample Apartment';
    const pn = document.getElementById('project-name');
    if (pn) pn.value = state.projectName;

    // All measurements in meters (~33ft x 23ft plot)
    const T = 0.15;            // wall thickness
    const W = 10, H = 7;       // plot interior

    const roomFill = {
      living:  '#e8f0ff', // sky tint
      kitchen: '#e7f7ec', // mint
      dining:  '#f3e9d2', // sand
      bed1:    '#fde9ef', // blush
      bed2:    '#efe8ff', // lilac
      bath:    '#e0f2fe', // pale sky
    };
    const stroke = '#94a3b8';
    const wallStroke = '#4a2e1c';

    state.objects = [
      // —— Parking (outside, to the right) ——
      makeObject('room', {
        x: W + 0.4, y: 0, w: 4, h: H,
        label: 'Parking',
        fill: '#f5efe6',
        stroke: '#94a3b8',
        strokeWidth: 2,
      }),
      // Parking perimeter walls (open on the side facing the house)
      makeObject('wall', { x1: W + 0.4, y1: 0,    x2: W + 4.4, y2: 0,    thickness: T, stroke: wallStroke }), // top
      makeObject('wall', { x1: W + 4.4, y1: 0,    x2: W + 4.4, y2: H,    thickness: T, stroke: wallStroke }), // right
      makeObject('wall', { x1: W + 4.4, y1: H,    x2: W + 0.4, y2: H,    thickness: T, stroke: wallStroke }), // bottom

      // —— Floor / zones ——
      makeObject('room', { x: 0,    y: 0,    w: 5.5, h: 4.2, label: 'Living Room', fill: roomFill.living,  stroke, strokeWidth: 2 }),
      makeObject('room', { x: 5.5,  y: 0,    w: 4.5, h: 2.5, label: 'Kitchen',     fill: roomFill.kitchen, stroke, strokeWidth: 2 }),
      makeObject('room', { x: 5.5,  y: 2.5,  w: 4.5, h: 1.7, label: 'Dining',      fill: roomFill.dining,  stroke, strokeWidth: 2 }),
      makeObject('room', { x: 0,    y: 4.2,  w: 4,   h: 2.8, label: 'Bedroom 1',   fill: roomFill.bed1,    stroke, strokeWidth: 2 }),
      makeObject('room', { x: 4,    y: 4.2,  w: 3.5, h: 2.8, label: 'Bedroom 2',   fill: roomFill.bed2,    stroke, strokeWidth: 2 }),
      makeObject('room', { x: 7.5,  y: 4.2,  w: 2.5, h: 2.8, label: 'Bathroom',    fill: roomFill.bath,    stroke, strokeWidth: 2 }),

      // \u2014\u2014 Outer walls (form the building shell) \u2014\u2014
      makeObject('wall', { x1: 0, y1: 0, x2: W, y2: 0, thickness: T, stroke: wallStroke }), // top
      makeObject('wall', { x1: W, y1: 0, x2: W, y2: H, thickness: T, stroke: wallStroke }), // right
      makeObject('wall', { x1: W, y1: H, x2: 0, y2: H, thickness: T, stroke: wallStroke }), // bottom
      makeObject('wall', { x1: 0, y1: H, x2: 0, y2: 0, thickness: T, stroke: wallStroke }), // left

      // \u2014\u2014 Interior walls \u2014\u2014
      makeObject('wall', { x1: 5.5, y1: 0,   x2: 5.5, y2: 4.2, thickness: T, stroke: wallStroke }), // living | kitchen/dining
      makeObject('wall', { x1: 5.5, y1: 2.5, x2: W,   y2: 2.5, thickness: T, stroke: wallStroke }), // kitchen | dining
      makeObject('wall', { x1: 0,   y1: 4.2, x2: W,   y2: 4.2, thickness: T, stroke: wallStroke }), // common | bedrooms
      makeObject('wall', { x1: 4,   y1: 4.2, x2: 4,   y2: H,   thickness: T, stroke: wallStroke }), // bed1 | bed2
      makeObject('wall', { x1: 7.5, y1: 4.2, x2: 7.5, y2: H,   thickness: T, stroke: wallStroke }), // bed2 | bath

      // \u2014\u2014 Doors (rot in degrees, w in metres) \u2014\u2014
      makeObject('door', { x: 1.4, y: 4.2, w: 0.9, rot: 0   }), // bedroom 1 entry
      makeObject('door', { x: 5.0, y: 4.2, w: 0.9, rot: 0   }), // bedroom 2 entry
      makeObject('door', { x: 8.4, y: 4.2, w: 0.8, rot: 0   }), // bathroom entry
      makeObject('door', { x: 5.5, y: 1.0, w: 0.9, rot: 90  }), // living -> kitchen
      makeObject('door', { x: 3.0, y: 0,   w: 1.0, rot: 0   }), // front entrance

      // \u2014\u2014 Windows \u2014\u2014
      makeObject('window', { x: 0.8, y: 0,   w: 1.6, rot: 0  }), // living window (front)
      makeObject('window', { x: 7.0, y: 0,   w: 1.4, rot: 0  }), // kitchen window
      makeObject('window', { x: 0,   y: 5.4, w: 1.4, rot: 90 }), // bedroom 1 (left wall)
      makeObject('window', { x: W,   y: 5.4, w: 1.4, rot: 90 }), // bathroom (right wall)

      // \u2014\u2014 Text labels \u2014\u2014
      makeObject('text', { x: 3.05, y: 0.45, text: 'Front Entrance', size: 12, fill: '#475569' }),

      // \u2014\u2014 Measurement (overall width) \u2014\u2014
      makeObject('measure', { x1: 0, y1: -0.55, x2: W, y2: -0.55 }),
    ];
  }
})();
