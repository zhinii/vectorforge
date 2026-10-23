// DXF R12 (ASCII) + SVG export. DXF is y-up natively, same as the model.
import { entityPoints, isClosed } from './model.mjs';

export function toDXF(doc) {
  const L = [];
  const push = (...lines) => L.push(...lines);
  push('0', 'SECTION', '2', 'ENTITIES');
  for (const e of doc.entities) {
    if (e.type === 'line') {
      push('0', 'LINE', '8', '0',
        '10', e.p1[0], '20', e.p1[1], '30', '0',
        '11', e.p2[0], '21', e.p2[1], '31', '0');
    } else if (e.type === 'circle') {
      push('0', 'CIRCLE', '8', '0', '10', e.c[0], '20', e.c[1], '30', '0', '40', e.r);
    } else if (e.type === 'arc') {
      push('0', 'ARC', '8', '0', '10', e.c[0], '20', e.c[1], '30', '0', '40', e.r,
        '50', e.a0, '51', e.a1);
    } else {
      const pts = entityPoints(e);
      push('0', 'LWPOLYLINE', '8', '0', '90', String(pts.length), '70', isClosed(e) ? '1' : '0');
      for (const p of pts) push('10', p[0], '20', p[1]);
    }
  }
  push('0', 'ENDSEC', '0', 'EOF');
  return L.join('\n');
}

export function toSVG(doc) {
  // Flip y so the SVG looks like the canvas (SVG is y-down).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of doc.entities) for (const p of entityPoints(e)) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!doc.entities.length) { minX = minY = 0; maxX = maxY = 100; }
  const pad = 10;
  const vb = [minX - pad, -(maxY + pad), (maxX - minX) + 2 * pad, (maxY - minY) + 2 * pad];
  const paths = doc.entities.map(e => {
    const pts = entityPoints(e);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + (-p[1])).join(' ')
      + (isClosed(e) ? 'Z' : '');
    return `<path d="${d}" fill="none" stroke="black" stroke-width="0.5"/>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${vb[2]}mm" height="${vb[3]}mm">\n  ${paths}\n</svg>\n`;
}

export function download(name, content, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
