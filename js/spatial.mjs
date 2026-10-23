// Exact, read-only CAD geometry. Coordinates are world units; scale is px/unit.
// Curves remain analytic: no sampled circle/arc vertices enter these helpers.
import { arcAngles, entityPoints, isClosed, dist, normalizeAngle } from './model.mjs?v=20261023-6';

const ANGLE_EPS = 1e-9;
const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const add = (a,b) => [a[0]+b[0],a[1]+b[1]];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
const mul = (a,t) => [a[0]*t,a[1]*t];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1];
const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
const midpoint = (a,b) => [a[0]/2+b[0]/2,a[1]/2+b[1]/2];
const polar = (e,a) => [e.c[0]+e.r*Math.cos(a),e.c[1]+e.r*Math.sin(a)];
const curved = e => e.type === 'circle' || e.type === 'arc';
const angleOf = (p,e) => Math.atan2(p[1]-e.c[1],p[0]-e.c[0]);
function onArc(e,a) {
  if (e.type === 'circle') return true;
  const {start,sweep} = arcAngles(e);
  const offset = normalizeAngle(a*180/Math.PI-start);
  return sweep === 360 || offset <= sweep+ANGLE_EPS || offset >= 360-ANGLE_EPS;
}
function curveEnds(e) {
  if (e.type === 'circle') return [];
  const {start,sweep} = arcAngles(e);
  return [polar(e,start*Math.PI/180),polar(e,(start+sweep)*Math.PI/180)];
}
function segments(e) {
  if (curved(e) || e.type==='bezier') return [];
  const pts=entityPoints(e), count=isClosed(e)?pts.length:pts.length-1;
  return Array.from({length:count},(_,i)=>({a:pts[i],b:pts[(i+1)%pts.length],index:i}));
}

/** Closest finite-segment projection. t is clamped, rawT is not. */
export function projectToSegment(p,a,b) {
  const v=sub(b,a), length=Math.hypot(...v);
  if (!length) return {point:a.slice(),t:0,rawT:0};
  const unit=mul(v,1/length), rawT=dot(sub(p,a),unit)/length;
  const t=Math.max(0,Math.min(1,rawT));
  return {point:add(a,mul(v,t)),t,rawT};
}

/** Exact nearest outline point, including endpoints of a bounded arc. */
export function nearestPointOnEntity(p,e) {
  if (!finitePoint(p) || !e || e.type==='bezier') return null;
  if (curved(e)) {
    let angle=angleOf(p,e);
    if (dist(p,e.c) === 0) angle=e.type==='arc'?arcAngles(e).start*Math.PI/180:0;
    if (onArc(e,angle)) return polar(e,angle);
    return curveEnds(e).sort((a,b)=>dist(p,a)-dist(p,b))[0];
  }
  const points=segments(e).map(s=>projectToSegment(p,s.a,s.b).point);
  return points.sort((a,b)=>dist(p,a)-dist(p,b))[0] || null;
}

// A discrete target wins over the continuously varying nearest-outline target.
const PRIORITY={endpoint:0,tangent:1,perpendicular:1,midpoint:2,center:3,nearest:4};
/**
 * Candidates within tolerancePx (default 10) at scale pixels/world unit.
 * from enables perpendicular finite-segment feet and exterior circle tangents.
 * mode='perpendicular'/'tangent' restricts candidates; 'all' is the default.
 * excludeIds accepts an array or Set. Results sort by discrete priority then px.
 */
export function snapCandidates(p,entities,{scale=1,tolerancePx=10,from=null,mode='all',excludeIds=[]}={}) {
  if (!finitePoint(p)) return [];
  scale=Number.isFinite(scale)&&scale>0?scale:1;
  tolerancePx=Number.isFinite(tolerancePx)?Math.max(0,tolerancePx):10;
  const excluded=new Set(excludeIds), result=[];
  const push=(point,kind,e,segmentIndex)=>{
    if (!finitePoint(point)) return;
    if (mode!=='all' && kind!==mode) return;
    const distancePx=dist(p,point)*scale;
    if (distancePx>tolerancePx+1e-10) return;
    result.push({point:point.slice(),kind,entityId:e.id,distancePx,...(segmentIndex===undefined?{}:{segmentIndex})});
  };
  for (const e of entities || []) {
    if (!e || excluded.has(e.id)) continue;
    if (e.type==='bezier') {
      push(e.p1,'endpoint',e); push(e.p2,'endpoint',e);
      if ([e.p1,e.c1,e.c2,e.p2].every(finitePoint)) push([
        e.p1[0]/8+e.c1[0]*3/8+e.c2[0]*3/8+e.p2[0]/8,
        e.p1[1]/8+e.c1[1]*3/8+e.c2[1]*3/8+e.p2[1]/8
      ],'midpoint',e);
      continue;
    }
    if (e.c) push(e.c,'center',e);
    if (e.type==='text') continue;
    if (curved(e)) {
      for (const end of curveEnds(e)) push(end,'endpoint',e);
      if (e.type==='arc') {
        const {start,sweep}=arcAngles(e);
        push(polar(e,(start+sweep/2)*Math.PI/180),'midpoint',e);
      }
      if (finitePoint(from)) {
        const d=dist(from,e.c);
        // At/on/inside the circle no nonzero tangent segment exists.
        if (d>e.r && d>0) {
          const a=angleOf(from,e), offset=Math.acos(Math.min(1,e.r/d));
          for (const angle of [a-offset,a+offset]) if (onArc(e,angle)) push(polar(e,angle),'tangent',e);
        }
      }
      push(nearestPointOnEntity(p,e),'nearest',e);
    } else {
      for (const s of segments(e)) {
        push(s.a,'endpoint',e,s.index); push(s.b,'endpoint',e,s.index);
        push(midpoint(s.a,s.b),'midpoint',e,s.index);
        push(projectToSegment(p,s.a,s.b).point,'nearest',e,s.index);
        if (finitePoint(from) && dist(s.a,s.b)>0) {
          const projection=projectToSegment(from,s.a,s.b);
          if (projection.rawT>=0 && projection.rawT<=1 && dist(from,projection.point)>0)
            push(projection.point,'perpendicular',e,s.index);
        }
      }
    }
  }
  return result.sort((a,b)=>PRIORITY[a.kind]-PRIORITY[b.kind] || a.distancePx-b.distancePx || String(a.entityId).localeCompare(String(b.entityId)));
}
export function snapPoint(point,entities,options) { return snapCandidates(point,entities,options)[0] || null; }

function pair(a,b) { return {from:a.slice(),to:b.slice(),clearance:dist(a,b)}; }
function bestPair(pairs) { return pairs.filter(p=>finitePoint(p.from)&&finitePoint(p.to)&&Number.isFinite(p.clearance)).sort((a,b)=>a.clearance-b.clearance)[0]; }
function pointOnCurve(p,e) { return nearestPointOnEntity(p,e); }
function segmentPair(a,b,c,d) {
  const v=sub(b,a),w=sub(d,c),den=cross(v,w);
  if (den!==0) {
    const t=cross(sub(c,a),w)/den,u=cross(sub(c,a),v)/den;
    if (t>=0&&t<=1&&u>=0&&u<=1) { const q=add(a,mul(v,t)); return pair(q,q); }
  }
  return bestPair([pair(a,projectToSegment(a,c,d).point),pair(b,projectToSegment(b,c,d).point),
    pair(projectToSegment(c,a,b).point,c),pair(projectToSegment(d,a,b).point,d)]);
}
function curveSegment(e,a,b) {
  const candidates=[pair(pointOnCurve(a,e),a),pair(pointOnCurve(b,e),b)];
  for (const p of curveEnds(e)) candidates.push(pair(p,projectToSegment(p,a,b).point));
  const v=sub(b,a),len=Math.hypot(...v);
  if (len>0) {
    const unit=mul(v,1/len);
    // Interior stationary pairs lie on the normal through the curve center.
    for (const normal of [[-unit[1],unit[0]],[unit[1],-unit[0]]]) {
      const angle=Math.atan2(normal[1],normal[0]);
      if (onArc(e,angle)) {
        const q=polar(e,angle),projection=projectToSegment(q,a,b);
        if (projection.rawT>=0&&projection.rawT<=1) candidates.push(pair(q,projection.point));
      }
    }
    // Exact line/circle intersections in segment coordinates; no quadratic
    // discriminant subtraction involving large absolute coordinates.
    const centerT=dot(sub(e.c,a),unit), h=Math.abs(cross(sub(e.c,a),unit));
    if (h<=e.r) {
      const offset=Math.sqrt(Math.max(0,(e.r-h)*(e.r+h)));
      for (const t of [centerT-offset,centerT+offset]) if (t>=0&&t<=len) {
        const q=add(a,mul(unit,t));
        if (onArc(e,angleOf(q,e))) candidates.push(pair(q,q));
      }
    }
  }
  return bestPair(candidates);
}
function curvePair(a,b) {
  const candidates=[];
  for (const p of curveEnds(a)) candidates.push(pair(p,pointOnCurve(p,b)));
  for (const p of curveEnds(b)) candidates.push(pair(pointOnCurve(p,a),p));
  const d=dist(a.c,b.c),base=d?angleOf(b.c,a):0;
  if (d===0) {
    // Concentric arcs: an overlap angle gives the radius difference; if their
    // angular spans are disjoint, endpoint candidates above give the minimum.
    const angles=[0,...curveEnds(a).map(p=>angleOf(p,a)),...curveEnds(b).map(p=>angleOf(p,b))];
    for (const angle of angles) if (onArc(a,angle)&&onArc(b,angle)) candidates.push(pair(polar(a,angle),polar(b,angle)));
  } else {
    for (const aa of [base,base+Math.PI]) for (const bb of [base,base+Math.PI])
      if (onArc(a,aa)&&onArc(b,bb)) candidates.push(pair(polar(a,aa),polar(b,bb)));
    if (d<=a.r+b.r && d>=Math.abs(a.r-b.r)) {
      const x=(d*d+(a.r-b.r)*(a.r+b.r))/(2*d);
      const h=Math.sqrt(Math.max(0,(a.r-x)*(a.r+x)));
      const u=mul(sub(b.c,a.c),1/d), center=add(a.c,mul(u,x));
      for (const sign of [-1,1]) {
        const q=add(center,mul([-u[1],u[0]],sign*h));
        if (onArc(a,angleOf(q,a))&&onArc(b,angleOf(q,b))) candidates.push(pair(q,q));
      }
    }
  }
  return bestPair(candidates);
}
function outlinePair(selected,target) {
  if (curved(selected) && target.curve) return curvePair(selected,target.curve);
  if (curved(selected)) return curveSegment(selected,target.a,target.b);
  const own=segments(selected);
  if (target.curve) return bestPair(own.map(s=>{const p=curveSegment(target.curve,s.a,s.b);return {from:p.to,to:p.from,clearance:p.clearance};}));
  return bestPair(own.map(s=>segmentPair(s.a,s.b,target.a,target.b)));
}

/**
 * Up to limit nearest target edges (default 3), sorted by exact outline gap.
 * One row per line/polygon edge or circular entity. maxDistance is world units.
 * {id,sourceId,targetId,targetType,segmentIndex?,clearance,from,to,
 *  centerDistance,centerFrom,centerTo}. Center values are null for non-curves.
 * from/to are closest outline points, coincident at intersections. A segment
 * wholly inside a circle has positive boundary clearance, NOT a disk overlap.
 * These are measurements only; they never establish or mutate constraints.
 */
export function nearbyMeasurements(selected,entities,{limit=3,maxDistance=Infinity}={}) {
  if (!selected || ['bezier','text'].includes(selected.type)) return [];
  limit=Number.isFinite(limit)?Math.max(0,Math.floor(limit)):3;
  const result=[];
  for (const e of entities || []) {
    if (!e || ['bezier','text'].includes(e.type) || e===selected || (selected.id!==undefined&&e.id===selected.id)) continue;
    const targets=curved(e)?[{curve:e}]:segments(e);
    for (const target of targets) {
      const p=outlinePair(selected,target);
      if (!p || p.clearance>maxDistance) continue;
      const centerFrom=curved(selected)?selected.c.slice():null;
      const centerTo=centerFrom?(target.curve?pointOnCurve(centerFrom,target.curve):projectToSegment(centerFrom,target.a,target.b).point):null;
      result.push({id:`${selected.id}:${e.id}:${target.index??'curve'}`,sourceId:selected.id,targetId:e.id,targetType:e.type,
        ...(target.index===undefined?{}:{segmentIndex:target.index}),...p,centerFrom,centerTo,
        centerDistance:centerFrom?dist(centerFrom,centerTo):null});
    }
  }
  return result.sort((a,b)=>a.clearance-b.clearance || (a.centerDistance??0)-(b.centerDistance??0) || a.id.localeCompare(b.id)).slice(0,limit);
}
