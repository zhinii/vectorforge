/** Bounded, local simplification of ONE traced segment between user anchors.
 * This is polyline reduction, not curve fitting or a manufacturing guarantee.
 */
const MAX_INPUT_POINTS = 2000;
const MAX_OUTPUT_POINTS = 256;
const MAX_DIMENSION = 320;
const MAX_PIXELS = 100000;

function dimension(value, name) {
  if (!Number.isInteger(value) || value < 2 || value > MAX_DIMENSION) {
    throw new RangeError(`${name} must be a prepared-image dimension in 2..320`);
  }
  return value;
}

function distance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

/**
 * Return fresh [u, v] pairs, retaining the exact first/last anchor coordinates.
 * width/height are the PREPARED image dimensions, not the original photo size.
 * Pixel coordinates are [u * (width - 1), v * (height - 1)], matching tracing.
 *
 * The tolerance bounds the continuous input polyline, not just its vertices:
 * each retained chord replaces only its corresponding contiguous subchain;
 * every subchain vertex is within tolerancePx of that chord. Distance to a
 * segment is convex, so the intervening edges satisfy the same bound. The
 * subchain's continuous projection covers the chord, giving the reverse bound
 * too. This does NOT preserve topology, enclosed area, or traversal distance.
 * Corners larger than the tolerance survive; subpixel staircase noise need not.
 *
 * Iterative RDP has bounded O(n^2) work and O(n) storage, n <= 2000. It never
 * relaxes tolerance to hit the cap: an over-budget candidate throws RangeError.
 * It does not search for the globally minimum-vertex approximation.
 */
export function simplifyGuidedSegment(points, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Simplification options must be an object');
  }
  const width = dimension(options.width, 'width');
  const height = dimension(options.height, 'height');
  if (width * height > MAX_PIXELS) throw new RangeError('Prepared image exceeds 100000 pixels');
  const tolerancePx = options.tolerancePx === undefined ? 1.5 : options.tolerancePx;
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0 || tolerancePx > Math.hypot(width - 1, height - 1)) {
    throw new RangeError('tolerancePx must be finite and between zero and the prepared-image diagonal');
  }
  const maxPoints = options.maxPoints === undefined ? MAX_OUTPUT_POINTS : options.maxPoints;
  if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > MAX_OUTPUT_POINTS) {
    throw new RangeError('maxPoints must be an integer in 2..256');
  }
  // Validate the size before allocating a point-sized buffer or visiting entries.
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_INPUT_POINTS) {
    throw new RangeError('A guided segment requires 2..2000 UV points');
  }
  const uv = new Array(points.length), pixels = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!Array.isArray(point) || point.length !== 2
      || !Number.isFinite(point[0]) || point[0] < 0 || point[0] > 1
      || !Number.isFinite(point[1]) || point[1] < 0 || point[1] > 1) {
      throw new RangeError('Every guided point must be a finite [u, v] pair in [0, 1]');
    }
    uv[i] = [point[0], point[1]];
    pixels[i] = [point[0] * (width - 1), point[1] * (height - 1)];
  }
  const last = points.length - 1, keep = new Uint8Array(points.length);
  keep[0] = keep[last] = 1;
  let keptCount = 2;
  const stack = [0, last];
  while (stack.length) {
    const end = stack.pop(), start = stack.pop();
    let farthest = -1, maxDistance = tolerancePx;
    for (let i = start + 1; i < end; i++) {
      const error = distance(pixels[i], pixels[start], pixels[end]);
      if (error > maxDistance) { maxDistance = error; farthest = i; }
    }
    if (farthest !== -1) {
      if (++keptCount > maxPoints) {
        throw new RangeError('Guided segment exceeds the point cap at the requested tolerance');
      }
      keep[farthest] = 1;
      stack.push(start, farthest, farthest, end);
    }
  }

  const indices = [];
  for (let i = 0; i <= last; i++) if (keep[i]) indices.push(i);
  // Independent final per-subchain verification: no silent truncation or
  // tolerance relaxation may slip through if the reduction is later changed.
  for (let k = 1; k < indices.length; k++) {
    const start = indices[k - 1], end = indices[k];
    for (let i = start + 1; i < end; i++) {
      if (distance(pixels[i], pixels[start], pixels[end]) > tolerancePx) {
        throw new RangeError('Simplified segment exceeds its pixel-error bound');
      }
    }
  }
  return indices.map(i => uv[i]);
}
