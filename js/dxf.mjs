// DXF R2000 (ASCII) + exact SVG export. Model and DXF coordinates are y-up.
import { entityPoints, isClosed, arcAngles, normalizeAngle } from './model.mjs?v=20261023-4';

function checkEntity(e) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const point = p => Array.isArray(p) && p.length === 2 && p.every(finite);
  if (e.type === 'line') {
    if (!point(e.p1) || !point(e.p2)) throw Error('Cannot export invalid line coordinates');
  } else {
    if (!point(e.c)) throw Error('Cannot export invalid entity coordinates');
    const positive = v => finite(v) && v > 0;
    if (['circle', 'arc'].includes(e.type)) {
      if (!positive(e.r) || (e.type === 'arc' && (!finite(e.a0) || !finite(e.a1)))) throw Error('Cannot export invalid circular geometry');
    } else if (e.type === 'rect') {
      if (!positive(e.w) || !positive(e.h)) throw Error('Cannot export invalid rectangle');
    } else if (['polygon', 'star'].includes(e.type)) {
      if (!positive(e.R) || !Number.isInteger(e.n) || e.n < 3 || e.n > (e.type === 'star' ? 32 : 64) || !finite(e.rot) ||
          (e.type === 'star' && (!positive(e.ratio) || e.ratio >= 1))) throw Error('Cannot export invalid polygon');
    } else throw Error('Cannot export unknown entity type: ' + e.type);
  }
}

export function toDXF(doc) {
  const L = [];
  const push = (...lines) => L.push(...lines);
  // LWPOLYLINE and explicit millimetre insertion units require a modern DXF,
  // not the R12 version previously claimed by this exporter.
  push('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015',
    '9', '$INSUNITS', '70', '4', '9', '$MEASUREMENT', '70', '1',
    '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  const entity = (type, subclass) => push('0', type, '100', 'AcDbEntity', '8', '0', '100', subclass);
  for (const e of doc.entities) {
    checkEntity(e);
    if (e.type === 'line') {
      entity('LINE', 'AcDbLine');
      push('10', e.p1[0], '20', e.p1[1], '30', '0', '11', e.p2[0], '21', e.p2[1], '31', '0');
    } else if (e.type === 'circle' || (e.type === 'arc' && arcAngles(e).sweep === 360)) {
      entity('CIRCLE', 'AcDbCircle');
      push('10', e.c[0], '20', e.c[1], '30', '0', '40', e.r);
    } else if (e.type === 'arc') {
      const { start, sweep, end } = arcAngles(e);
      if (sweep === 0) {
        const p = entityPoints(e)[0];
        entity('POINT', 'AcDbPoint'); push('10', p[0], '20', p[1], '30', '0');
      } else {
        entity('ARC', 'AcDbCircle');
        push('10', e.c[0], '20', e.c[1], '30', '0', '40', e.r,
          '100', 'AcDbArc', '50', start, '51', normalizeAngle(end));
      }
    } else {
      const pts = entityPoints(e);
      entity('LWPOLYLINE', 'AcDbPolyline');
      push('90', pts.length, '70', isClosed(e) ? '1' : '0');
      for (const p of pts) push('10', p[0], '20', p[1]);
    }
  }
  push('0', 'ENDSEC', '0', 'EOF');
  return L.join('\n') + '\n';
}

function polar(e, angle) {
  const a = normalizeAngle(angle) * Math.PI / 180;
  return [e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)];
}
function extentPoints(e) {
  if (e.type === 'circle') return [[e.c[0] - e.r, e.c[1] - e.r], [e.c[0] + e.r, e.c[1] + e.r]];
  if (e.type !== 'arc') return entityPoints(e);
  const { start, sweep, end } = arcAngles(e);
  const angles = [start, end, ...[0, 90, 180, 270].filter(a => normalizeAngle(a - start) <= sweep)];
  return angles.map(a => polar(e, a));
}
export function toSVG(doc) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of doc.entities) {
    checkEntity(e);
    for (const p of extentPoints(e)) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
  }
  if (!doc.entities.length) { minX = minY = 0; maxX = maxY = 100; }
  const pad = 10;
  const vb = [minX - pad, -(maxY + pad), maxX - minX + 2 * pad, maxY - minY + 2 * pad];
  if (!vb.every(Number.isFinite)) throw Error('Cannot export geometry outside the finite drawing range');
  const style = 'fill="none" stroke="black" stroke-width="0.5"';
  const paths = doc.entities.map(e => {
    if (e.type === 'circle' || (e.type === 'arc' && arcAngles(e).sweep === 360)) {
      return `<circle cx="${e.c[0]}" cy="${-e.c[1]}" r="${e.r}" ${style}/>`;
    }
    if (e.type === 'arc') {
      const { start, sweep, end } = arcAngles(e), a = polar(e, start), b = polar(e, end);
      const d = `M${a[0]} ${-a[1]}` + (sweep ? ` A${e.r} ${e.r} 0 ${sweep > 180 ? 1 : 0} 0 ${b[0]} ${-b[1]}` : '');
      return `<path d="${d}" ${style}/>`;
    }
    const d = entityPoints(e).map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + (-p[1])).join(' ') + (isClosed(e) ? 'Z' : '');
    return `<path d="${d}" ${style}/>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${vb[2]}mm" height="${vb[3]}mm">\n  ${paths}\n</svg>\n`;
}

export function download(name, content, mime) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  a.href = url; a.download = name;
  document.body.appendChild(a);
  try { a.click(); } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
