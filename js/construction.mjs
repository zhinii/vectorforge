// Transient construction geometry only. No document edits, DOM, or retained state.
// Coordinates are model-space millimetres (y-up); arc angles are degrees, CCW.
const LIMIT = 1e12;
const CIRCLE_SEGMENTS = 64;
const validPoint = p => Array.isArray(p) && p.length === 2 &&
  p.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMIT);
const copy = p => p.slice();
const bounded = p => p.map(v => Math.max(-LIMIT, Math.min(LIMIT, v)));
const normalize = a => ((a % 360) + 360) % 360;
const polar = (c, r, a) => [c[0] + r * Math.cos(a * Math.PI / 180), c[1] + r * Math.sin(a * Math.PI / 180)];
const marker = (point, label, kind = 'committed') => ({ point: copy(point), label, kind });
const empty = () => ({ guides: [], curve: null, markers: [], stepKey: '' });
const cubic = (p1, c1, c2, p2) => ({ type: 'bezier', p1: copy(p1), c1: copy(c1), c2: copy(c2), p2: copy(p2) });

/**
 * Preview the existing four-tap Bézier or center/start/end three-tap arc.
 * All returned arrays are owned by the result. Invalid pending geometry returns
 * an empty preview; a missing/invalid cursor falls back to the last fixed point.
 * Tentative Bézier defaults are suggestions only and never change pending data.
 * Work is constant-bounded: at most 65 circle-guide points and four markers.
 */
export function constructionPreview(tool, pending, cursor) {
  if (!['bezier', 'arc'].includes(tool) || !pending || !validPoint(pending.start)) return empty();
  const start = copy(pending.start);
  if (tool === 'bezier') {
    if ((pending.control1 != null && !validPoint(pending.control1)) ||
        (pending.control2 != null && (!validPoint(pending.control2) || !validPoint(pending.control1)))) return empty();
    const c1 = pending.control1, c2 = pending.control2;
    const next = copy(validPoint(cursor) ? cursor : c2 || c1 || start);
    const markers = [marker(start, 'Start')];
    if (!c1) {
      markers.push(marker(next, 'Control 1', 'tentative'));
      const dx = next[0] - start[0], dy = next[1] - start[1];
      if (dx === 0 && dy === 0) {
        return { guides: [], curve: null, markers: [marker(start, 'Start')],
          stepKey: 'Bézier 2/4: Place first control' };
      }
      // Rotate the first handle clockwise to propose an arch, rather than
      // displaying a misleading straight line before the other taps exist.
      const proposedControl = bounded([next[0] + dy, next[1] - dx]);
      const proposedEnd = bounded([start[0] + dy, start[1] - dx]);
      markers.push(marker(proposedControl, 'Control 2', 'tentative'), marker(proposedEnd, 'End (preview)', 'tentative'));
      return { guides: [[copy(start), copy(next), copy(proposedControl), copy(proposedEnd)]],
        curve: cubic(start, next, proposedControl, proposedEnd), markers,
        stepKey: 'Bézier 2/4: Place first control' };
    }
    markers.push(marker(c1, 'Control 1'));
    if (!c2) {
      // Reflect the first handle at the tentative second control to suggest an
      // endpoint. Immediately after tap 2, keep a visibly bent suggestion even
      // though the cursor still coincides with the first control.
      const dx = c1[0] - start[0], dy = c1[1] - start[1];
      const handleLength = Math.hypot(dx, dy);
      const nearby = handleLength ? Math.max(0, 1 - Math.hypot(next[0] - c1[0], next[1] - c1[1]) / handleLength) : 0;
      // Fade the non-collapsing fallback smoothly as the second handle moves.
      const proposedEnd = bounded([next[0] - dx + dy * nearby, next[1] - dy - dx * nearby]);
      markers.push(marker(next, 'Control 2', 'tentative'), marker(proposedEnd, 'End (preview)', 'tentative'));
      return { guides: [[copy(start), copy(c1), copy(next), copy(proposedEnd)]],
        curve: cubic(start, c1, next, proposedEnd), markers,
        stepKey: 'Bézier 3/4: Place second control' };
    }
    markers.push(marker(c2, 'Control 2'), marker(next, 'End', 'tentative'));
    return { guides: [[copy(start), copy(c1), copy(c2), copy(next)]],
      curve: cubic(start, c1, c2, next), markers,
      stepKey: 'Bézier 4/4: Place end point' };
  }

  const hasRadius = pending.radius != null;
  if (hasRadius && (typeof pending.radius !== 'number' || !Number.isFinite(pending.radius) ||
      pending.radius <= 0 || pending.radius > LIMIT || typeof pending.a0 !== 'number' ||
      !Number.isFinite(pending.a0) || Math.abs(pending.a0) > LIMIT)) return empty();
  const fallback = hasRadius ? polar(start, pending.radius, normalize(pending.a0)) : start;
  const next = validPoint(cursor) ? cursor : fallback;
  const angle = normalize(Math.atan2(next[1] - start[1], next[0] - start[0]) * 180 / Math.PI);
  const radius = hasRadius ? pending.radius : Math.min(LIMIT, Math.max(0.5, Math.hypot(next[0] - start[0], next[1] - start[1])));
  const a0 = hasRadius ? normalize(pending.a0) : angle;
  const arcStart = polar(start, radius, a0);
  const circle = Array.from({ length: CIRCLE_SEGMENTS + 1 }, (_, i) => polar(start, radius, i * 360 / CIRCLE_SEGMENTS));
  // Close with the exact first point, avoiding a microscopic trigonometric seam.
  circle[CIRCLE_SEGMENTS] = copy(circle[0]);
  const guides = [circle, [copy(start), copy(arcStart)]];
  const markers = [marker(start, 'Center'), marker(arcStart, 'Arc start', hasRadius ? 'committed' : 'tentative')];
  if (!hasRadius) {
    return { guides, curve: { type: 'arc', center: copy(start), radius, start: a0, end: a0 + 360 }, markers,
      stepKey: 'Arc 2/3: Set radius and start' };
  }
  const arcEnd = polar(start, radius, angle);
  guides.push([copy(start), copy(arcEnd)]);
  markers.push(marker(arcEnd, 'Arc end', 'tentative'));
  return { guides, curve: { type: 'arc', center: copy(start), radius, start: a0, end: a0 + normalize(angle - a0) }, markers,
    stepKey: 'Arc 3/3: Set end angle (CCW)' };
}
