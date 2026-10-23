// VectorForge main — canvas rendering, interaction, dimension editing, chat.
import { createDoc, applyOps, serializeScene, entityPoints, entityGrips, entityDimensions,
         distanceToEntity, moveEntity, isClosed } from './model.mjs?v=20261023-6';
import { askAgent, validateConnection, readRelayStatus, DEFAULTS, RELAY } from './agent.mjs?v=20261023-6';
import { toDXF, toSVG, download } from './dxf.mjs?v=20261023-6';
import { snapPoint, nearbyMeasurements } from './spatial.mjs?v=20261023-6';
import { t, setLanguage, getLanguage, applyTranslations } from './i18n.mjs?v=20261023-6';

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
  return JSON.stringify({ entities: doc.entities, timeline: doc.timeline, selectedId: doc.selectedId, labelOffsets });
}
function pushUndo() { cancelDesignRequest(); undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
function restore(snap) {
  const d = JSON.parse(snap);
  doc.entities = d.entities; doc.timeline = d.timeline; doc.selectedId = d.selectedId;
  labelOffsets = d.labelOffsets || {};
  pending = null; drag = null; refreshTimeline(); draw();
}
function undo() { if (!undoStack.length) return; cancelDesignRequest(); redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; cancelDesignRequest(); undoStack.push(snapshot()); restore(redoStack.pop()); }

// ---- interaction state ----
let tool = 'select';
let drag = null;          // {mode:'pan'} | {mode:'grip',e,grip} | {mode:'move',e,start}
let dimBoxes = [];        // screen-space rects of dimension labels, for dblclick
let mouse = [0, 0];       // world coords
let clipboard = null, pasteCount = 0;
let snapEnabled = true, snapTarget = null;
let labelOffsets = {}, selectedMeasurement = null, measurementsEnabled = true;
const centerOf = e => e.p1 ? [(e.p1[0] + e.p2[0])/2, (e.p1[1] + e.p2[1])/2] : e.c;

const COARSE = window.matchMedia('(pointer: coarse)').matches;
const GRIP_TOL = COARSE ? 18 : 7;   // px
const PICK_TOL = COARSE ? 16 : 6;   // px
function drawingPoint(point) {
  snapTarget = snapEnabled && (tool !== 'select' || drag?.mode === 'grip') ? snapPoint(point, doc.entities, {
    scale: view.s, tolerancePx: COARSE ? 18 : 10,
    from: tool === 'line' ? pending?.start : null,
    excludeIds: drag?.e ? [drag.e.id] : [],
  }) : null;
  return snapTarget?.point || point;
}

// ---- drawing tools (click-click) ----
let pending = null;       // first point / partial params for the active tool

function canvasClick(world) {
  if (tool === 'select') return false;
  if (tool === 'text') {
    textPosition = world.slice();
    document.getElementById('text-content').value='';
    document.getElementById('text-size').value='10';
    document.getElementById('text-error').hidden=true;
    openDialog(textDialog,document.getElementById('text-content'));
    return true;
  }
  if (!pending) {
    pending = { start: world };
    setHint(tool === 'bezier' ? 'Click the first control handle' : tool === 'line' ? 'Click the end point' :
            tool === 'circle' ? 'Click the radius' :
            tool === 'rect' ? 'Click the opposite corner' :
            tool === 'star' ? 'Click the outer radius' :
            tool === 'arc' ? 'Click the start angle' : '');
    return true;
  }
  const [x0, y0] = pending.start, [x1, y1] = world;
  let op = null;
  if (tool === 'bezier') {
    if (!pending.control1) { pending.control1 = world; setHint('Click the second control handle'); return true; }
    if (!pending.control2) { pending.control2 = world; setHint('Click the end point'); return true; }
    op = { op: 'bezier', from: pending.start, control1: pending.control1, control2: pending.control2, to: world };
  }
  if (tool === 'line' && Math.hypot(x1-x0, y1-y0) < .001) return true;
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
  pending = null; snapTarget = null;
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
  if (tool === 'bezier') {
    const a = w2s(pending.start), b = w2s(mouse);
    ctx.moveTo(...a);
    if (pending.control2) ctx.bezierCurveTo(...w2s(pending.control1), ...w2s(pending.control2), ...b);
    else { if (pending.control1) ctx.lineTo(...w2s(pending.control1)); ctx.lineTo(...b); }
  }
  else if (tool === 'line') { const a = w2s([x0, y0]), b = w2s([x1, y1]); ctx.moveTo(...a); ctx.lineTo(...b); }
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
  document.getElementById('undo').disabled = !undoStack.length;
  document.getElementById('redo').disabled = !redoStack.length;
  document.getElementById('delete-selected').disabled = !doc.entities.some(e => e.id === doc.selectedId);
  document.getElementById('copy-selected').disabled = !doc.entities.some(e => e.id === doc.selectedId);
  document.getElementById('paste-selected').disabled = !clipboard;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  drawGrid(W, H);
  dimBoxes = [];

  for (const e of doc.entities) {
    if (e.type === 'text') {
      ctx.save(); ctx.font = `${e.size*view.s}px sans-serif`; ctx.textBaseline='alphabetic';
      ctx.fillStyle=e.id===doc.selectedId?'#ffb84d':'#dbe2ec'; ctx.fillText(e.text,...w2s(e.c)); ctx.restore(); continue;
    }
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
  if (sel) { drawGrips(sel); drawDimensions(sel); if (measurementsEnabled) drawNearbyDimensions(sel); }
  drawPreview();
  drawSnapTarget();
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
  if (e.type === 'bezier') {
    ctx.save(); ctx.strokeStyle = '#637a96'; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(...w2s(e.p1)); ctx.lineTo(...w2s(e.c1));
    ctx.moveTo(...w2s(e.p2)); ctx.lineTo(...w2s(e.c2)); ctx.stroke(); ctx.restore();
  }
  ctx.fillStyle = '#4da3ff';
  for (const g of entityGrips(e)) {
    const s = w2s(g.get());
    ctx.fillRect(s[0] - 3.5, s[1] - 3.5, 7, 7);
  }
  const c = centerOf(e);
  const s = w2s(c);
  ctx.strokeStyle = '#4da3ff';
  ctx.strokeRect(s[0] - 3.5, s[1] - 3.5, 7, 7);
}

function drawDimensions(e) {
  ctx.font = '12px system-ui';
  for (const d of entityDimensions(e)) {
    const s = w2s(d.anchor);
    const text = t(d.label);
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

// Measurements are read-only geometry observations, not permanent constraints.
// Their offsets are screen-space annotations so dragging a label cannot reshape.
function drawNearbyDimensions(e) {
  const nearby = nearbyMeasurements(e, doc.entities, { limit: Math.max(1, Math.min(3, Math.floor((canvas.clientHeight - 42) / 44))), maxDistance: 180 / view.s });
  ctx.save(); ctx.font = '12px system-ui';
  nearby.forEach((m, i) => {
    const key = m.id;
    const a = w2s(m.from), b = w2s(m.to);
    const anchor = [(a[0]+b[0])/2, (a[1]+b[1])/2];
    // Common stack origin prevents unrelated gap midpoints from colliding.
    const center = w2s(centerOf(e));
    const stackY = Math.max(22, Math.min(canvas.clientHeight - nearby.length * 44 - 20, center[1] - 42));
    const offset = labelOffsets[key] || [center[0] + 24 - anchor[0], stackY + i * 44 - anchor[1]];
    const rounded = v => Math.round(v * 100) / 100;
    const lines = m.centerDistance !== null
      ? [`${m.targetId} · ${t('Center distance')} ${rounded(m.centerDistance)} ${t('mm')}`, `${t('Edge clearance')} ${rounded(m.clearance)} ${t('mm')}`]
      : [`${m.targetId} · ${t('Clearance')} ${rounded(m.clearance)} ${t('mm')}`];
    const width = Math.max(...lines.map(line=>ctx.measureText(line).width)) + 12;
    const height=lines.length*16+6;
    const x = Math.max(4, Math.min(canvas.clientWidth-width-4, anchor[0]+offset[0]));
    const y = Math.max(22, Math.min(canvas.clientHeight-height-20, anchor[1]+offset[1]));
    ctx.strokeStyle = '#76d9b0'; ctx.setLineDash([3,3]); ctx.beginPath();
    ctx.moveTo(...a); ctx.lineTo(...b); ctx.moveTo(...anchor); ctx.lineTo(x, y-5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(17,49,41,.96)'; ctx.fillRect(x-4,y-15,width,height);
    ctx.strokeStyle = selectedMeasurement === key ? '#c3ffe7' : '#347b62'; ctx.strokeRect(x-4,y-15,width,height);
    ctx.fillStyle = '#a5ecd0'; lines.forEach((line,j)=>ctx.fillText(line,x+2,y+j*16));
    dimBoxes.push({ x:x-4,y:y-15,w:width,h:height, measurement:m, labelKey:key, offset:offset.slice(), entity:e });
  });
  ctx.restore();
}
function drawSnapTarget() {
  if (!snapTarget) return;
  const p = w2s(snapTarget.point);
  ctx.save(); ctx.strokeStyle = '#6df0b4'; ctx.fillStyle = '#6df0b4'; ctx.lineWidth = 1.5;
  if (pending && ['perpendicular','tangent'].includes(snapTarget.kind)) {
    ctx.setLineDash([5,4]); ctx.beginPath(); ctx.moveTo(...w2s(pending.start)); ctx.lineTo(...p); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeRect(p[0]-6,p[1]-6,12,12); ctx.font = '12px system-ui';
  ctx.fillText(t(snapTarget.kind),p[0]+12,p[1]-12); ctx.restore();
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
    const center = centerOf(e);
    const d = Math.min(distanceToEntity(p, e), Math.hypot(p[0] - center[0], p[1] - center[1]));
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
let suppressGesture = false;
let toolTap = null;
function dimensionAt(s) { return dimBoxes.find(b => s[0] >= b.x - 4 && s[0] <= b.x + b.w + 4 && s[1] >= b.y - 4 && s[1] <= b.y + b.h + 4); }

canvas.addEventListener('pointerdown', ev => {
  if (document.querySelector('dialog[open]')) return;
  const s = evPos(ev);
  if (tool === 'select' && ev.button === 0 && pointers.size === 0) {
    const box = dimensionAt(s);
    if (box) {
      ev.preventDefault();
      if (!box.measurement) { openDimension(box); return; }
      selectedMeasurement = box.labelKey;
      drag = { mode:'label', box, screen:s, pointerId:ev.pointerId };
      canvas.setPointerCapture(ev.pointerId); pointers.set(ev.pointerId,s); draw(); return;
    }
  }
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, s);
  if (pointers.size === 2) {
    // Second finger down: cancel any drag, start pinch-zoom/pan.
    drag = null; toolTap = null; suppressGesture = true;
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (ev.pointerType === 'touch' && pointers.size > 1) return;
  if (ev.button === 1 || ev.button === 2) { drag = { mode: 'pan', start: s, ox: view.ox, oy: view.oy }; return; }
  if (ev.button !== 0 && ev.pointerType !== 'touch') return;
  if (suppressGesture) return;
  if (tool !== 'select') { toolTap = { id: ev.pointerId, screen: s }; return; }
  const g = gripAt(s);
  if (g) { drag = { mode: 'grip', ...g, screen: s, pointerId: ev.pointerId }; return; }
  const e = entityAt(s);
  if (e) {
    doc.selectedId = e.id;
    drag = { mode: 'move', e, start: s2w(s), screen: s, pointerId: ev.pointerId, moved: false };
  } else {
    doc.selectedId = null;
  }
  draw();
});

canvas.addEventListener('pointermove', ev => {
  const s = evPos(ev);
  mouse = drawingPoint(s2w(s));
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, s);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // pan with the midpoint, zoom by the distance ratio around it
    const anchor = s2w(pinch.mid);
    const ratio = pinch.dist > 0 && dist > 0 ? dist / pinch.dist : 1;
    view.s = Math.min(200, Math.max(0.05, view.s * ratio));
    view.ox = mid[0] - anchor[0] * view.s;
    view.oy = mid[1] + anchor[1] * view.s;
    pinch = { dist, mid };
    draw();
    return;
  }
  if (suppressGesture || !drag) { draw(); return; }
  if (drag.mode !== 'pan' && drag.pointerId !== ev.pointerId) return;
  if (drag.mode !== 'pan' && !drag.undoPushed && !drag.moved && Math.hypot(s[0]-drag.screen[0], s[1]-drag.screen[1]) < 4) return;
  if (drag.mode === 'pan') {
    view.ox = drag.ox + (s[0] - drag.start[0]);
    view.oy = drag.oy + (s[1] - drag.start[1]);
  } else if (drag.mode === 'label') {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    labelOffsets[drag.box.labelKey] = drag.box.offset.map((v,i) => v+s[i]-drag.screen[i]);
  } else if (drag.mode === 'grip') {
    if (!drag.undoPushed) { pushUndo(); drag.undoPushed = true; }
    try { drag.grip.set(mouse); } catch { drag = null; addMsg('err', 'That edit is outside the supported drawing range.'); }
  } else if (drag.mode === 'move') {
    if (!drag.moved) { pushUndo(); drag.moved = true; }
    try { moveEntity(drag.e, [mouse[0] - drag.start[0], mouse[1] - drag.start[1]]); drag.start = mouse; }
    catch { drag = null; addMsg('err', 'That move is outside the supported drawing range.'); }
  }
  draw();
});

function endPointer(ev) {
  if (ev.type === 'pointerup' && toolTap?.id === ev.pointerId && !suppressGesture &&
      Math.hypot(...evPos(ev).map((v, i) => v - toolTap.screen[i])) < 10) canvasClick(drawingPoint(s2w(evPos(ev))));
  toolTap = null;
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { drag = null; suppressGesture = false; }
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', ev => { pointers.delete(ev.pointerId); if (!pointers.size) { drag = null; pinch = null; toolTap = null; suppressGesture = false; } });
canvas.addEventListener('contextmenu', ev => ev.preventDefault());
// Keep two-finger drawing navigation inside the canvas, including mobile
// browsers with legacy Touch Events. Browser zoom elsewhere remains enabled.
for (const type of ['touchstart', 'touchmove']) {
  canvas.addEventListener(type, ev => ev.preventDefault(), { passive: false });
}

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

// Dimension labels open one accessible editor; dismissing never changes geometry.
let dimensionBox = null;
const dimensionDialog = document.getElementById('dimension-dialog');
function openDimension(box) {
  dimensionBox = box;
  document.getElementById('dimension-title').textContent = `${box.entity.id}: ${t(box.dim.key)}`;
  const input = document.getElementById('dim-edit');
  input.value = String(box.dim.value);
  document.getElementById('dimension-error').hidden = true;
  openDialog(dimensionDialog, input);
  input.select();
}
document.getElementById('dimension-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const v = Number(document.getElementById('dim-edit').value);
  if (!dimensionBox || !doc.entities.includes(dimensionBox.entity)) { dimensionDialog.close(); return; }
  if (!Number.isFinite(v) || v <= 0 || v > 1e6) {
    const error = document.getElementById('dimension-error');
    error.textContent = t('Enter a positive value up to 1,000,000 mm.'); error.hidden = false; return;
  }
  if (v !== dimensionBox.dim.value) {
    pushUndo();
    applyOps(doc, [{ op: 'set_dimension', id: dimensionBox.entity.id, dimension: dimensionBox.dim.key, value: v }]);
    refreshTimeline(); draw();
  }
  dimensionDialog.close();
});

// ---- keyboard ----
window.addEventListener('keydown', ev => {
  if (document.querySelector('dialog[open]')) return;
  if (ev.key === 'Escape' && timelinePanel.classList.contains('open')) { ev.preventDefault(); setTimeline(false); return; }
  if (ev.target.closest('input, textarea, select, [contenteditable=true]')) return;
  const k = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
  else if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); }
  else if ((ev.ctrlKey || ev.metaKey) && k === 'c') { if (copySelection()) ev.preventDefault(); }
  else if ((ev.ctrlKey || ev.metaKey) && k === 'v') { if (clipboard) { ev.preventDefault(); pasteSelection(); } }
  else if (k === 'escape') { pending = null; doc.selectedId = null; setTool('select'); draw(); }
  else if (k === 'delete' || k === 'backspace') {
    ev.preventDefault();
    deleteSelection();
  }
  else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && { v: 'select', l: 'line', c: 'circle', r: 'rect', s: 'star', a: 'arc', b: 'bezier', t:'text' }[k]) setTool({ v: 'select', l: 'line', c: 'circle', r: 'rect', s: 'star', a: 'arc', b: 'bezier', t:'text' }[k]);
});

// ---- toolbar / statusbar ----
function setTool(t) { tool = t; pending = null; snapTarget = null;
  document.querySelectorAll('#draw-tools .tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  canvas.classList.toggle('selecting', t === 'select');
  draw();
  setHint(t === 'select' ? '' : t === 'text' ? 'Click to place text' : 'Click the ' + (t === 'line' || t === 'bezier' ? 'start point' : t === 'rect' ? 'first corner' : 'centre point'));
}
document.querySelectorAll('#draw-tools .tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);
function deleteSelection() {
  if (!doc.entities.some(e => e.id === doc.selectedId)) return;
  pushUndo(); applyOps(doc, [{ op: 'delete', id: doc.selectedId }]);
  pending = null; refreshTimeline(); draw();
}
document.getElementById('delete-selected').addEventListener('click', deleteSelection);
function copySelection() {
  const entity = doc.entities.find(e => e.id === doc.selectedId);
  if (!entity) return false;
  clipboard = JSON.parse(JSON.stringify(entity)); pasteCount = 0; draw();
  setHint('Copied. Paste creates an offset copy.'); return true;
}
function pasteSelection() {
  if (!clipboard) return;
  const e = JSON.parse(JSON.stringify(clipboard));
  try {
    const offset = 24 / view.s * (pasteCount + 1);
    moveEntity(e, [offset, -offset]);
    const op = { op:e.type, from:e.p1, to:e.p2, control1:e.c1, control2:e.c2, center:e.c, radius:e.r ?? e.R,
      width:e.w, height:e.h, start:e.a0, end:e.a1, sides:e.n, points:e.n, innerRatio:e.ratio, rotation:e.rot,
      at:e.c,text:e.text,size:e.size };
    const before = snapshot(); cancelDesignRequest();
    const { created } = applyOps(doc,[op]);
    undoStack.push(before); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0;
    pasteCount++; doc.selectedId = created[0]; pending = null; refreshTimeline(); draw();
  } catch { addMsg('err','That copy is outside the supported drawing range.'); }
}
document.getElementById('copy-selected').addEventListener('click',copySelection);
document.getElementById('paste-selected').addEventListener('click',pasteSelection);
document.getElementById('snap-toggle').addEventListener('click', () => {
  snapEnabled = !snapEnabled; snapTarget = null;
  document.getElementById('snap-toggle').setAttribute('aria-pressed',String(snapEnabled));
  document.getElementById('snap-toggle').classList.toggle('active',snapEnabled); draw();
});
document.getElementById('measurements-toggle').addEventListener('click', () => {
  measurementsEnabled = !measurementsEnabled;
  document.getElementById('measurements-toggle').setAttribute('aria-pressed',String(measurementsEnabled));
  document.getElementById('measurements-toggle').classList.toggle('active',measurementsEnabled); draw();
});
function exportDrawing(format) {
  try {
    download('design.' + format, format === 'dxf' ? toDXF(doc) : toSVG(doc), format === 'dxf' ? 'application/dxf' : 'image/svg+xml');
    if (format === 'dxf' && doc.entities.some(e => e.type === 'bezier')) addMsg('ai','DXF Bézier curves are approximated by polylines. SVG curves are exact.');
    if (doc.entities.some(e=>e.type==='text')) addMsg('ai','Text exports as editable text, not outlined cutting paths.');
  }
  catch { addMsg('err', 'Export failed: the drawing contains invalid geometry. Undo the last edit and try again.'); }
}
document.getElementById('export-dxf').addEventListener('click', () => exportDrawing('dxf'));
document.getElementById('export-svg').addEventListener('click', () => exportDrawing('svg'));

const hintEl = document.getElementById('hint');
const DEFAULT_HINT = hintEl.textContent;
let currentHint = '';
function setHint(text) { currentHint = text; hintEl.textContent = t(text || DEFAULT_HINT); }
let coordQueued = false;
function requestCoords() {
  if (coordQueued) return;
  coordQueued = true;
  requestAnimationFrame(() => {
    coordQueued = false;
    document.getElementById('coords').textContent =
      mouse.map(v => (Math.round(v * 10) / 10)).join(', ') + ' ' + t('mm');
  });
}

// ---- timeline UI ----
const translateTimeline = text => t(text);
function refreshTimeline() {
  const ul = document.getElementById('timeline');
  ul.innerHTML = '';
  doc.timeline.forEach((t, i) => {
    const li = document.createElement('li');
    if (t.source === 'ai') li.classList.add('ai-op');
    const label = document.createElement('span'); label.textContent = `${i + 1}. ${translateTimeline(t.text)}`;
    const source = document.createElement('span'); source.className = 'src'; source.textContent = translateTimeline(t.source);
    li.append(label, source);
    if (t.ids.length && t.ids.every(id => doc.entities.some(e => e.id === id))) {
      const b = document.createElement('button');
      b.textContent = translateTimeline('select');
      b.addEventListener('click', () => { doc.selectedId = t.ids[0]; draw(); });
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
  ul.scrollTop = ul.scrollHeight;
}

// ---- panels and dialogs ----
// Fixed overlays follow the visual viewport, not an off-screen layout viewport
// after mobile page zoom/pan or the on-screen keyboard. Never reset page zoom.
function syncOverlayViewport() {
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth;
  const height = viewport?.height || window.innerHeight;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const root = document.documentElement.style;
  root.setProperty('--overlay-left', (left + width / 2) + 'px');
  root.setProperty('--overlay-top', (top + height / 2) + 'px');
  root.setProperty('--overlay-width', Math.max(40, width - 24) + 'px');
  root.setProperty('--overlay-height', Math.max(40, height - 24) + 'px');
  const drawerWidth = Math.min(300, Math.max(40, width - 24));
  const workspaceTop = document.getElementById('workspace').getBoundingClientRect().top;
  // Prefer the scene edge, but float above it when the keyboard/zoom leaves little height.
  const drawerMinHeight = Math.min(240, Math.max(40, height - 24));
  const drawerTop = Math.min(top + height - drawerMinHeight - 12, Math.max(top + 12, workspaceTop + 8));
  root.setProperty('--drawer-left', (left + width - drawerWidth - 12) + 'px');
  root.setProperty('--drawer-top', drawerTop + 'px');
  root.setProperty('--drawer-width', drawerWidth + 'px');
  root.setProperty('--drawer-height', Math.max(40, top + height - drawerTop - 12) + 'px');
}
window.visualViewport?.addEventListener('resize', syncOverlayViewport);
window.visualViewport?.addEventListener('scroll', syncOverlayViewport);
window.addEventListener('resize', syncOverlayViewport);

const dlg = document.getElementById('settings-dialog');
const timelinePanel = document.getElementById('timeline-panel');
const timelineToggle = document.getElementById('timeline-toggle');
function setTimeline(open, restoreFocus = true) {
  if (open) syncOverlayViewport();
  timelinePanel.classList.toggle('open', open);
  timelinePanel.inert = !open;
  timelinePanel.setAttribute('aria-hidden', String(!open));
  timelineToggle.setAttribute('aria-expanded', String(open));
  if (open) document.getElementById('timeline-close').focus({ preventScroll: true });
  else if (restoreFocus) timelineToggle.focus({ preventScroll: true });
}
timelineToggle.addEventListener('click', () => setTimeline(!timelinePanel.classList.contains('open')));
document.getElementById('timeline-close').addEventListener('click', () => setTimeline(false));
document.addEventListener('pointerdown', ev => {
  if (timelinePanel.classList.contains('open') && !timelinePanel.contains(ev.target) && !timelineToggle.contains(ev.target)) setTimeline(false, false);
});
function openDialog(dialog, focus) {
  syncOverlayViewport();
  pending = null; drag = null; toolTap = null; pointers.clear(); pinch = null;
  setTimeline(false, false); draw();
  if (!dialog.open) dialog.showModal();
  focus?.focus({ preventScroll: true });
}
function wireDialog(dialog, closeIds) {
  let opener = null, outsideDown = false;
  dialog.addEventListener('close', () => { opener?.focus({ preventScroll: true }); });
  dialog.addEventListener('pointerdown', ev => {
    const r = dialog.getBoundingClientRect();
    outsideDown = ev.target === dialog && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom);
  });
  dialog.addEventListener('click', ev => { if (outsideDown && ev.target === dialog) dialog.close(); outsideDown = false; });
  for (const id of closeIds) document.getElementById(id).addEventListener('click', () => dialog.close());
  // Native showModal supplies background inertness, focus trapping, and Escape.
  return () => { opener = document.activeElement; };
}
const rememberSettingsFocus = wireDialog(dlg, ['settings-close', 'settings-cancel']);
wireDialog(dimensionDialog, ['dimension-close', 'dimension-cancel']);
dimensionDialog.addEventListener('close', () => { dimensionBox = null; canvas.focus({ preventScroll: true }); });
let textPosition=null;
const textDialog=document.getElementById('text-dialog');
wireDialog(textDialog,['text-close','text-cancel']);
textDialog.addEventListener('close',()=>{textPosition=null;canvas.focus({preventScroll:true});});
document.getElementById('text-form').addEventListener('submit',ev=>{
  ev.preventDefault(); if(!textPosition)return;
  const text=document.getElementById('text-content').value;
  const size=Number(document.getElementById('text-size').value);
  try {
    const before=snapshot();
    const {created}=applyOps(doc,[{op:'text',at:textPosition,text,size}]);
    cancelDesignRequest(); undoStack.push(before); if(undoStack.length>100)undoStack.shift();redoStack.length=0;
    doc.selectedId=created[0];textDialog.close();refreshTimeline();draw();
  } catch {
    const error=document.getElementById('text-error');
    error.textContent=t('Enter 1–120 characters on one line and a positive text size up to 1,000,000 mm.');error.hidden=false;
  }
});

// ---- per-tab connection; intentionally never persisted ----
try { localStorage.removeItem('vectorforge.connection'); sessionStorage.removeItem('vectorforge.connection'); } catch { /* Storage may be blocked. */ }
let connection = { ...DEFAULTS, mode:'server', relay: RELAY, useRelay: true, key: '' };
const connLight = document.getElementById('conn-light');
let connState = 'off';
let connDetail = null;
let activeRequest = null;
const history = [];
const chatLog = document.getElementById('chat-log');
const messageEntries = [];
function setConn(state, detail) {
  connState = state; connLight.className = state;
  document.getElementById('connect-btn').hidden = state === 'on' || state === 'ready';
  document.getElementById('connect-btn').disabled = state === 'checking';
  connDetail = detail;
  connLight.title = t(detail || { off: 'Not connected. Use Connect in the console.', ready:'Server connection ready. Provider will be checked on your first request.', checking: 'Checking connection…', on: 'Connected', error: 'Connection failed. Use Connect to retry.' }[state]);
  connLight.setAttribute('aria-label', connLight.title);
}
function addMsg(cls, text, who, translate = true) {
  const div = document.createElement('div'); div.className = 'msg ' + cls;
  const label = document.createElement('span'); label.className = 'who';
  const labelText = who || (cls === 'user' ? 'you >' : cls === 'err' ? 'error >' : 'ai >');
  label.textContent = t(labelText);
  div.appendChild(label);
  const safeText = String(text).replace(/sk-[A-Za-z0-9._-]{6,}/g, '[redacted]');
  const body = document.createTextNode(cls !== 'user' && translate ? t(safeText) : safeText);
  div.appendChild(body);
  messageEntries.push({label, labelText, body, safeText, translate:cls !== 'user' && translate});
  chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight; return div;
}
function setBusy(busy) {
  document.getElementById('cancel-request').hidden = !busy;
  document.getElementById('send-btn').disabled = busy;
  document.getElementById('chat-form').setAttribute('aria-busy', String(busy));
}
function cancelRequest(message = 'Request stopped. Nothing from it was applied.') {
  if (!activeRequest) return;
  const request = activeRequest; activeRequest = null;
  request.controller.abort(); request.thinking?.remove();
  if (request.kind === 'connect' || request.kind === 'health') setConn('off');
  setBusy(false);
  if (message) addMsg('ai', message);
}
function cancelDesignRequest() {
  if (activeRequest?.kind === 'design') cancelRequest('Drawing changed. The pending AI request was stopped; send it again to use the current scene.');
}
document.getElementById('cancel-request').addEventListener('click', () => cancelRequest());
const ERRORS = {
  server_configuration: 'The saved server key is not configured. Try your own API key in API settings.',
  mode_credentials: 'The connection mode and credentials do not match. Check API settings.',
  origin: 'The relay rejected this website origin. Its allowed origins must include this app.',
  request: 'The relay rejected the request format. Check that the app and relay versions match.',
  scene_required: 'The relay could not read the drawing scene. Check that the app and relay versions match.',
  content_type: 'The relay rejected the request content type.',
  size: 'The drawing request is too large for the relay. Try a smaller scene.',
  rate_limit: 'The relay is busy or its request limit was reached. Wait a moment and retry.',
  configuration: 'The relay endpoint or model configuration is invalid.',
  connection: 'The relay could not reach the provider. Check the endpoint and retry.',
  auth: 'The API key was rejected (401/403). Check your key and endpoint.',
  quota: 'The provider or relay rate limit was reached. Check your quota or retry shortly.',
  cors: 'Cannot reach the relay or provider. Check the relay URL and network; this can also be a CORS configuration problem.',
  relay_missing: 'The CAD relay returned 404. Its /api/cad-chat route must be deployed.',
  relay: 'Use the configured CAD relay host, or a localhost /api/cad-chat development route.',
  endpoint: 'Choose a supported Alibaba API endpoint.', credentials: 'Enter a valid sk-… key and model name.',
  model: 'The model and endpoint do not match. Check API settings.',
  invalid: 'The model returned invalid drawing operations. Nothing was applied.',
  response: 'The provider returned an unreadable response. Nothing was applied.',
  timeout: 'The request timed out. Try again.', provider: 'The provider is unavailable. Try again later.',
};
function errorText(error) { return ERRORS[error.message] || 'The request could not be completed. Nothing was applied. Try a smaller request.'; }
async function testConnection(config) {
  cancelRequest(null);
  connection = config; history.length = 0;
  const request = { kind: 'connect', controller: new AbortController() };
  activeRequest = request; setBusy(true); setConn('checking');
  try {
    await askAgent(config, { question: 'connection_check', language:getLanguage(), history: [], scene: { units: 'mm', entities: [] } }, request.controller.signal);
    if (activeRequest !== request) return;
    setConn('on', 'Connected to ' + config.model);
    addMsg('ai', `Connected to ${config.model}. Describe a design, or use the drawing tools.`);
  } catch (error) {
    if (activeRequest !== request) return;
    setConn('error'); addMsg('err', 'Connection test failed. ' + errorText(error));
  } finally { if (activeRequest === request) { activeRequest = null; setBusy(false); } }
}
async function checkServerConnection() {
  cancelRequest(null);
  const request = {kind:'health',controller:new AbortController()};
  activeRequest=request; setBusy(true); setConn('checking');
  const timer=setTimeout(()=>request.controller.abort(),10000);
  try {
    const status=await readRelayStatus(connection,request.controller.signal);
    if (activeRequest!==request) return;
    if (!status.serverConfigured) throw Error('server_configuration');
    connection.model=status.serverModel || DEFAULTS.model;
    setConn('ready');
  } catch(error) {
    if(activeRequest!==request) return;
    setConn('error'); addMsg('err',errorText(error));
  } finally { clearTimeout(timer); if(activeRequest===request) {activeRequest=null;setBusy(false);} }
}
document.getElementById('connect-btn').addEventListener('click', () => {
  if (connection.mode === 'byok') { openConnectionSettings(); return; }
  checkServerConnection();
});
function syncConnectionMode() {
  const server = document.getElementById('set-mode').value === 'server';
  for (const id of ['set-base','set-model','set-key','set-relay']) document.getElementById(id).disabled=server;
  if (server) document.getElementById('set-key').value='';
}
document.getElementById('set-mode').addEventListener('change',syncConnectionMode);
function openConnectionSettings() {
  rememberSettingsFocus();
  document.getElementById('set-mode').value=connection.mode;
  for (const name of ['base', 'model']) document.getElementById('set-' + name).value = connection[name];
  document.getElementById('set-key').value = '';
  document.getElementById('set-relay-url').value = connection.relay;
  document.getElementById('set-relay').checked = connection.useRelay;
  document.getElementById('settings-error').hidden = true;
  syncConnectionMode();
  openDialog(dlg, document.getElementById('settings-close'));
}
connLight.addEventListener('click', openConnectionSettings);
dlg.addEventListener('close', () => { document.getElementById('set-key').value = ''; });
document.getElementById('settings-form').addEventListener('submit', ev => {
  ev.preventDefault();
  let config;
  try { config = validateConnection({
    mode: document.getElementById('set-mode').value,
    base: document.getElementById('set-base').value.trim() || DEFAULTS.base,
    model: document.getElementById('set-model').value.trim() || DEFAULTS.model,
    key: document.getElementById('set-key').value.trim() || connection.key,
    relay: document.getElementById('set-relay-url').value.trim() || RELAY,
    useRelay: document.getElementById('set-relay').checked,
  }); } catch (error) {
    const feedback = document.getElementById('settings-error'); feedback.textContent = t(errorText(error)); feedback.hidden = false; return;
  }
  dlg.close(); addMsg('ai', 'Checking the connection…');
  if (config.mode === 'server') { connection = config; history.length = 0; checkServerConnection(); } else testConnection(config);
});
document.getElementById('settings-disconnect').addEventListener('click', () => {
  cancelRequest(null); connection.key = ''; history.length = 0; setConn('off'); dlg.close();
  addMsg('ai', 'Disconnected. The key has been cleared from this tab.');
});

document.getElementById('chat-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const input = document.getElementById('chat-input');
  const q = input.value.trim(); if (!q) return;
  const keyMatch = /^(?:key|api[- ]?key)?\s*[:=]?\s*(sk-[\w.\-]{6,})$/i.exec(q);
  if (keyMatch) {
    input.value = '';
    try { const config = validateConnection({ ...connection, mode:'byok', key: keyMatch[1] }); addMsg('ai', 'Key received for this tab only. Checking the connection…'); testConnection(config); }
    catch (error) { addMsg('err', errorText(error)); }
    return;
  }
  // Never echo or send a secret pasted as part of a larger command.
  if (/sk-/i.test(q)) { input.value = ''; addMsg('err', 'Paste the API key by itself or use API settings. The text was not sent or displayed.'); return; }
  if (activeRequest) { addMsg('err', 'A request is running. Wait, or use Stop first.'); return; }
  if (connState !== 'on' && connState !== 'ready') { addMsg('err', 'Use Connect in the console. Manual drawing and export work offline.'); return; }
  if (q.length > 1600) { addMsg('err', 'Keep the design request under 1,600 characters.'); return; }
  input.value = ''; addMsg('user', q);
  const request = { kind: 'design', controller: new AbortController(), thinking: addMsg('ai', 'Working…') };
  // Freeze submitted selection in scene; selection/pan/zoom during a request
  // must not discard it. Only geometry changes invalidate this snapshot.
  const scene = serializeScene(doc), sceneBefore = JSON.stringify(doc.entities);
  activeRequest = request; setBusy(true);
  try {
    const result = await askAgent(connection, { question: q, history, scene, language:getLanguage() }, request.controller.signal);
    if (activeRequest !== request) return;
    setConn('on', 'Connected to ' + connection.model);
    if (JSON.stringify(doc.entities) !== sceneBefore) { cancelRequest('The selection or drawing changed. Send the request again for the current scene.'); return; }
    // Validate/apply atomically before recording success, and avoid cancelling ourselves.
    activeRequest = null;
    if (result.ops.length) {
      const before = snapshot();
      const { created } = applyOps(doc, result.ops, 'ai');
      undoStack.push(before); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0;
      if (created.length) doc.selectedId = created.at(-1);
      refreshTimeline(); draw();
    }
    request.thinking.remove(); addMsg('ai', result.reply, null, false);
    history.push({ role: 'user', content: q }, { role: 'assistant', content: result.reply });
    if (history.length > 12) history.splice(0, history.length - 12);
  } catch (error) {
    if (request.controller.signal.aborted) return;
    request.thinking.remove();
    if (!['invalid','response'].includes(error.message)) setConn('error');
    addMsg('err', errorText(error));
  } finally { if (!activeRequest || activeRequest === request) { activeRequest = null; setBusy(false); } }
});

// ---- boot ----
document.getElementById('language-toggle').addEventListener('click', () => {
  setLanguage(getLanguage() === 'en' ? 'zh' : 'en'); applyTranslations(document); setHint(currentHint);
  refreshTimeline(); setConn(connState, connDetail);
  for (const entry of messageEntries) {
    entry.label.textContent = t(entry.labelText);
    entry.body.textContent = entry.translate ? t(entry.safeText) : entry.safeText;
  }
  if (dimensionBox) document.getElementById('dimension-title').textContent = `${dimensionBox.entity.id}: ${t(dimensionBox.dim.key)}`;
  draw();
});
applyTranslations(document);
view.ox = canvas.clientWidth / 2 || 500;
view.oy = canvas.clientHeight / 2 || 400;
window.addEventListener('blur', () => { drag = null; toolTap = null; pointers.clear(); pinch = null; suppressGesture = false; });
window.addEventListener('resize', resize);
new ResizeObserver(resize).observe(canvas);
resize(); refreshTimeline(); setTool('select');
addMsg('ai', 'VectorForge ready. The prototype uses the saved server key; no paste or sign-in is needed. Advanced connection options are available through the status light. Manual drawing and export work offline.');
checkServerConnection();
