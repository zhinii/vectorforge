// VectorForge main — canvas rendering, interaction, dimension editing, chat.
import { createDoc, applyOps, serializeScene, entityPoints, entityGrips, entityDimensions,
         distanceToEntity, moveEntity, isClosed } from './model.mjs';
import { askAgent, validateConnection, DEFAULTS } from './agent.mjs';
import { toDXF, toSVG, download } from './dxf.mjs';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const doc = createDoc();

// ---- view transform (world y-up ↔ screen y-down) ----
const view = { s: 4, ox: 0, oy: 0 }; // px per mm, screen offset
const w2s = p => [view.ox + p[0] * view.s, view.oy - p[1] * view.s];
const s2w = p => [(p[0] - view.ox) / view.s, (view.oy - p[1]) / view.s];

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

// ---- undo/redo (document snapshots) ----
const undoStack = [], redoStack = [];
function snapshot() {
  return JSON.stringify({ entities: doc.entities, timeline: doc.timeline, selectedId: doc.selectedId });
}
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
function restore(snap) {
  const d = JSON.parse(snap);
  doc.entities = d.entities; doc.timeline = d.timeline; doc.selectedId = d.selectedId;
  refreshTimeline(); draw();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// ---- interaction state ----
let tool = 'select';
let drag = null;          // {mode:'pan'} | {mode:'grip',e,grip} | {mode:'move',e,start}
let dimBoxes = [];        // screen-space rects of dimension labels, for dblclick
let mouse = [0, 0];       // world coords

const COARSE = window.matchMedia('(pointer: coarse)').matches;
const GRIP_TOL = COARSE ? 18 : 7;   // px
const PICK_TOL = COARSE ? 16 : 6;   // px

// ---- drawing tools (click-click) ----
let pending = null;       // first point / partial params for the active tool

function canvasClick(world) {
  if (tool === 'select') return false;
  if (!pending) {
    pending = { start: world };
    setHint(tool === 'line' ? 'Click the end point' :
            tool === 'circle' ? 'Click the radius' :
            tool === 'rect' ? 'Click the opposite corner' :
            tool === 'star' ? 'Click the outer radius' :
            tool === 'arc' ? 'Click the start angle' : '');
    return true;
  }
  const [x0, y0] = pending.start, [x1, y1] = world;
  let op = null;
  if (tool === 'line') op = { op: 'line', from: [x0, y0], to: [x1, y1] };
  else if (tool === 'circle') op = { op: 'circle', center: [x0, y0], radius: Math.max(0.5, Math.hypot(x1 - x0, y1 - y0)) };
  else if (tool === 'rect') op = { op: 'rect', center: [(x0 + x1) / 2, (y0 + y1) / 2], width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  else if (tool === 'star') op = { op: 'star', center: [x0, y0], radius: Math.max(0.5, Math.hypot(x1 - x0, y1 - y0)), points: 5 };
  else if (tool === 'arc') {
    if (!pending.radius) { pending.radius = Math.max(0.5, Math.hypot(x1 - x0, y1 - y0)); pending.a0 = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI; setHint('Click the end angle'); return true; }
    const a1 = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    op = { op: 'arc', center: pending.start, radius: pending.radius, start: pending.a0, end: a1 };
  }
  if (op && (op.op !== 'rect' || (op.width > 0.5 && op.height > 0.5))) {
    pushUndo();
    const { created } = applyOps(doc, [op]);
    doc.selectedId = created[0] || null;
    refreshTimeline();
  }
  pending = null;
  setHint('');
  draw();
  return true;
}

function drawPreview() {
  if (!pending) return;
  const [x0, y0] = pending.start, [x1, y1] = mouse;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (tool === 'line') { const a = w2s([x0, y0]), b = w2s([x1, y1]); ctx.moveTo(...a); ctx.lineTo(...b); }
  else if (tool === 'circle' || (tool === 'arc' && !pending.radius) || tool === 'star') {
    const c = w2s([x0, y0]); ctx.arc(c[0], c[1], Math.hypot(x1 - x0, y1 - y0) * view.s, 0, 2 * Math.PI);
  } else if (tool === 'rect') {
    const a = w2s([x0, y0]), b = w2s([x1, y1]);
    ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  } else if (tool === 'arc' && pending.radius) {
    const c = w2s([x0, y0]);
    const a1 = Math.atan2(y1 - y0, x1 - x0);
    // canvas angles are y-down: negate world angles
    ctx.arc(c[0], c[1], pending.radius * view.s, -pending.a0 * Math.PI / 180, -a1, true);
  }
  ctx.stroke();
  ctx.restore();
}

// ---- rendering ----
function draw() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  drawGrid(W, H);
  dimBoxes = [];

  for (const e of doc.entities) {
    const pts = entityPoints(e);
    const sel = e.id === doc.selectedId;
    ctx.beginPath();
    pts.forEach((p, i) => { const s = w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
    if (isClosed(e)) ctx.closePath();
    ctx.strokeStyle = sel ? '#ffb84d' : '#dbe2ec';
    ctx.lineWidth = sel ? 2 : 1.25;
    ctx.stroke();
  }
  // grips + dimensions of the selected entity (context, per design discussion)
  const sel = doc.entities.find(e => e.id === doc.selectedId);
  if (sel) { drawGrips(sel); drawDimensions(sel); }
  drawPreview();
  requestCoords();
}

function drawGrid(W, H) {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  let step = steps.find(st => st * view.s >= 18) || 500;
  const tl = s2w([0, H]), br = s2w([W, 0]);
  ctx.lineWidth = 1;
  for (let x = Math.floor(tl[0] / step) * step; x <= br[0]; x += step) {
    const sx = w2s([x, 0])[0];
    ctx.strokeStyle = Math.abs(x) < 1e-9 ? '#3d4a5f' : (x % (step * 5) === 0 ? '#232b38' : '#1a2029');
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
  }
  for (let y = Math.floor(tl[1] / step) * step; y <= br[1]; y += step) {
    const sy = w2s([0, y])[1];
    ctx.strokeStyle = Math.abs(y) < 1e-9 ? '#3d4a5f' : (y % (step * 5) === 0 ? '#232b38' : '#1a2029');
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
  }
}

function drawGrips(e) {
  ctx.fillStyle = '#4da3ff';
  for (const g of entityGrips(e)) {
    const s = w2s(g.get());
    ctx.fillRect(s[0] - 3.5, s[1] - 3.5, 7, 7);
  }
  const c = e.type === 'line' ? [(e.p1[0] + e.p2[0]) / 2, (e.p1[1] + e.p2[1]) / 2] : e.c;
  const s = w2s(c);
  ctx.strokeStyle = '#4da3ff';
  ctx.strokeRect(s[0] - 3.5, s[1] - 3.5, 7, 7);
}

function drawDimensions(e) {
  ctx.font = '12px system-ui';
  for (const d of entityDimensions(e)) {
    const s = w2s(d.anchor);
    const text = d.label;
    const w = ctx.measureText(text).width;
    const x = s[0] + 10, y = s[1] - 10;
    ctx.fillStyle = 'rgba(22,40,61,.92)';
    ctx.fillRect(x - 4, y - 13, w + 8, 18);
    ctx.strokeStyle = '#24466b';
    ctx.strokeRect(x - 4, y - 13, w + 8, 18);
    ctx.fillStyle = '#9fc9ff';
    ctx.fillText(text, x, y);
    dimBoxes.push({ x: x - 4, y: y - 13, w: w + 8, h: 18, dim: d, entity: e });
  }
}

// ---- picking ----
function gripAt(screen) {
  const e = doc.entities.find(x => x.id === doc.selectedId);
  if (!e) return null;
  for (const g of entityGrips(e)) {
    const s = w2s(g.get());
    if (Math.hypot(s[0] - screen[0], s[1] - screen[1]) <= GRIP_TOL) return { e, grip: g };
  }
  return null;
}

function entityAt(screen) {
  const p = s2w(screen);
  let best = null, bestD = PICK_TOL / view.s;
  for (const e of doc.entities) {
    const d = distanceToEntity(p, e);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ---- mouse + touch events ----
function evPos(ev) {
  const r = canvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

const pointers = new Map(); // active pointerId → screen pos (for pinch)
let pinch = null;           // {dist, mid}

canvas.addEventListener('pointerdown', ev => {
  canvas.setPointerCapture(ev.pointerId);
  const s = evPos(ev);
  pointers.set(ev.pointerId, s);
  if (pointers.size === 2) {
    // Second finger down: cancel any drag, start pinch-zoom/pan.
    drag = null;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (ev.pointerType === 'touch' && pointers.size > 1) return;
  if (ev.button === 1 || ev.button === 2) { drag = { mode: 'pan', start: s, ox: view.ox, oy: view.oy }; return; }
  if (ev.button !== 0 && ev.pointerType !== 'touch') return;
  if (tool !== 'select') { canvasClick(s2w(s)); return; }
  const g = gripAt(s);
  if (g) { drag = { mode: 'grip', ...g }; return; }
  const e = entityAt(s);
  if (e) {
    doc.selectedId = e.id;
    drag = { mode: 'move', e, start: s2w(s), moved: false };
  } else {
    doc.selectedId = null;
  }
  draw();
});

canvas.addEventListener('pointermove', ev => {
  const s = evPos(ev);
  mouse = s2w(s);
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, s);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // pan with the midpoint, zoom by the distance ratio around it
    const before = s2w(mid);
    view.s = Math.min(200, Math.max(0.05, view.s * dist / (pinch.dist || dist)));
    const after = s2w(mid);
    view.ox += (after[0] - before[0]) * view.s + (mid[0] - pinch.mid[0]);
    view.oy -= (after[1] - before[1]) * view.s - (mid[1] - pinch.mid[1]);
    pinch = { dist, mid };
    draw();
    return;
  }
  if (!drag) { draw(); return; }
  if (drag.mode === 'pan') {
    view.ox = drag.ox + (s[0] - drag.start[0]);
    view.oy = drag.oy + (s[1] - drag.start[1]);
  } else if (drag.mode === 'grip') {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    drag.grip.set(mouse);
  } else if (drag.mode === 'move') {
    if (!drag.moved) { pushUndo(); drag.moved = true; }
    moveEntity(drag.e, [mouse[0] - drag.start[0], mouse[1] - drag.start[1]]);
    drag.start = mouse;
  }
  draw();
});

function endPointer(ev) {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0 && (drag?.mode === 'pan' || ev.button === 0 || ev.pointerType === 'touch')) drag = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', ev => ev.preventDefault());

canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  const s = evPos(ev);
  const before = s2w(s);
  view.s *= ev.deltaY < 0 ? 1.12 : 1 / 1.12;
  view.s = Math.min(200, Math.max(0.05, view.s));
  const after = s2w(s);
  view.ox += (after[0] - before[0]) * view.s;
  view.oy -= (after[1] - before[1]) * view.s;
  draw();
}, { passive: false });

// Double-click a dimension label → type a value → entity reshapes (driving dim).
canvas.addEventListener('dblclick', ev => {
  const s = evPos(ev);
  const box = dimBoxes.find(b => s[0] >= b.x && s[0] <= b.x + b.w && s[1] >= b.y && s[1] <= b.y + b.h);
  if (!box) return;
  const input = document.createElement('input');
  input.id = 'dim-edit';
  input.value = Math.round(box.dim.value * 10) / 10;
  const r = canvas.getBoundingClientRect();
  input.style.left = (r.left + box.x) + 'px';
  input.style.top = (r.top + box.y - 6) + 'px';
  document.body.appendChild(input);
  input.focus(); input.select();
  const commit = ok => {
    const v = parseFloat(input.value);
    input.remove();
    if (ok && Number.isFinite(v) && v > 0) {
      pushUndo();
      box.dim.set(v);
      doc.timeline.push({ text: `${box.entity.id} ${box.dim.key} = ${v} mm`, source: 'user', ids: [box.entity.id] });
      refreshTimeline();
    }
    draw();
  };
  input.addEventListener('keydown', e2 => {
    if (e2.key === 'Enter') commit(true);
    else if (e2.key === 'Escape') commit(false);
    e2.stopPropagation();
  });
  input.addEventListener('blur', () => commit(true));
});

// ---- keyboard ----
window.addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT') return;
  const k = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
  else if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); }
  else if (k === 'escape') { pending = null; doc.selectedId = null; setTool('select'); draw(); }
  else if (k === 'delete' || k === 'backspace') {
    if (doc.selectedId) { pushUndo(); applyOps(doc, [{ op: 'delete', id: doc.selectedId }]); doc.selectedId = null; refreshTimeline(); draw(); }
  }
  else if ({ v: 'select', l: 'line', c: 'circle', r: 'rect', s: 'star', a: 'arc' }[k]) setTool({ v: 'select', l: 'line', c: 'circle', r: 'rect', s: 'star', a: 'arc' }[k]);
});

// ---- toolbar / statusbar ----
function setTool(t) { tool = t; pending = null;
  document.querySelectorAll('#draw-tools .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.classList.toggle('selecting', t === 'select');
  setHint(t === 'select' ? '' : 'Click the ' + (t === 'line' ? 'start point' : t === 'rect' ? 'first corner' : 'centre point'));
}
document.querySelectorAll('#draw-tools .tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);
document.getElementById('export-dxf').addEventListener('click', () => download('design.dxf', toDXF(doc), 'application/dxf'));
document.getElementById('export-svg').addEventListener('click', () => download('design.svg', toSVG(doc), 'image/svg+xml'));

const hintEl = document.getElementById('hint');
const DEFAULT_HINT = hintEl.textContent;
function setHint(t) { hintEl.textContent = t || DEFAULT_HINT; }
let coordQueued = false;
function requestCoords() {
  if (coordQueued) return;
  coordQueued = true;
  requestAnimationFrame(() => {
    coordQueued = false;
    document.getElementById('coords').textContent =
      mouse.map(v => (Math.round(v * 10) / 10)).join(', ') + ' mm';
  });
}

// ---- timeline UI ----
function refreshTimeline() {
  const ul = document.getElementById('timeline');
  ul.innerHTML = '';
  doc.timeline.forEach((t, i) => {
    const li = document.createElement('li');
    if (t.source === 'ai') li.classList.add('ai-op');
    li.innerHTML = `<span>${i + 1}. ${t.text}</span><span class="src">${t.source}</span>`;
    if (t.ids.length && t.ids.every(id => doc.entities.some(e => e.id === id))) {
      const b = document.createElement('button');
      b.textContent = 'select';
      b.addEventListener('click', () => { doc.selectedId = t.ids[0]; draw(); });
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
}

// ---- settings ----
const LS_KEY = 'vectorforge.connection';
function loadConn() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
const dlg = document.getElementById('settings-dialog');
document.getElementById('settings-btn').addEventListener('click', () => {
  const c = loadConn();
  document.getElementById('set-base').value = c.base;
  document.getElementById('set-model').value = c.model;
  document.getElementById('set-key').value = c.key || '';
  document.getElementById('set-relay').checked = c.useRelay !== false;
  dlg.showModal();
});
document.getElementById('settings-save').addEventListener('click', ev => {
  ev.preventDefault();
  const c = {
    base: document.getElementById('set-base').value.trim() || DEFAULTS.base,
    model: document.getElementById('set-model').value.trim() || DEFAULTS.model,
    key: document.getElementById('set-key').value.trim(),
    useRelay: document.getElementById('set-relay').checked,
  };
  try { validateConnection(c); } catch (e) {
    addMsg('err', 'Connection rejected: only https Alibaba endpoints (qianwenaiapi.com / aliyuncs.com), a valid model name and a key are allowed.');
    return;
  }
  localStorage.setItem(LS_KEY, JSON.stringify(c));
  dlg.close();
  addMsg('ai', 'Connection saved. Ask me to draw something — e.g. "draw me a star, radius 60".');
});

// ---- timeline drawer toggle ----
const timelinePanel = document.getElementById('timeline-panel');
document.getElementById('timeline-toggle').addEventListener('click', () => timelinePanel.classList.toggle('open'));

// ---- chat ----
const history = [];
const chatLog = document.getElementById('chat-log');
function addMsg(cls, text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  const label = document.createElement('span');
  label.className = 'who';
  label.textContent = who || (cls === 'user' ? 'you >' : cls === 'err' ? 'error >' : 'ai >');
  div.appendChild(label);
  div.appendChild(document.createTextNode(text));
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

document.getElementById('chat-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const input = document.getElementById('chat-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  // Connect by pasting the key into the console: "sk-..." or "key sk-...".
  const keyMatch = /^(?:key|api[- ]?key)?\s*[:=]?\s*(sk-[\w.\-]{6,})$/i.exec(q);
  if (keyMatch) {
    const c = { ...loadConn(), key: keyMatch[1] };
    try {
      validateConnection(c);
      localStorage.setItem(LS_KEY, JSON.stringify(c));
      addMsg('ai', 'Connected — API key saved in this browser only. Now describe a design, e.g. "draw me a star, radius 60".');
    } catch { addMsg('err', 'That key was rejected (format check failed). Nothing was saved.'); }
    return;
  }
  addMsg('user', q);
  const conn = loadConn();
  if (!conn.key) {
    addMsg('err', 'Not connected yet. Paste your Qwen API key here in the console (it starts with "sk-") and I\'ll save it in this browser only.');
    return;
  }
  const thinking = addMsg('ai', '…', 'ai >');
  try {
    const scene = serializeScene(doc);
    const res = await askAgent(conn, { question: q, history, scene });
    thinking.remove();
    addMsg('ai', res.reply);
    history.push({ role: 'user', content: q }, { role: 'assistant', content: res.reply });
    if (res.ops.length) {
      pushUndo();
      const { created } = applyOps(doc, res.ops, 'ai');
      if (created.length) doc.selectedId = created[created.length - 1];
      refreshTimeline();
      draw();
    }
  } catch (e) {
    thinking.remove();
    const why = { auth: 'Authentication failed — check the API key under API.',
      quota: 'Quota exhausted on this key.',
      endpoint: 'Endpoint rejected — only Alibaba https endpoints are allowed.',
      model: 'Model/endpoint mismatch — check API settings.',
      invalid: 'The model returned ops outside the schema; nothing was drawn.',
      truncated: 'The response was cut off; try a smaller request.' }[e.message];
    addMsg('err', why || ('Request failed: ' + e.message));
  }
});

// ---- boot ----
view.ox = canvas.clientWidth / 2 || 500;
view.oy = canvas.clientHeight / 2 || 400;
window.addEventListener('resize', resize);
resize();
refreshTimeline();
addMsg('ai', 'VectorForge ready. Paste your Qwen API key (sk-…) here to connect, then describe a design — or draw with the chips below. Drag grips to reshape; double-tap a dimension to type its value.');
