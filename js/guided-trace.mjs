/** Local intelligent-scissors tracing. No uploads, threshold masks, or inferred silhouettes.
 * UV uses image coordinates: x right, y down. Rotate in the caller's image/world transform.
 * Image preparation and each search have hard memory/work limits. A segment is NOT a
 * reliable manufacturing contour until the caller reviews its uncertain flag.
 */
const HARD_SOURCE_DIM = 1024;
const HARD_SOURCE_PIXELS = 1024 * 1024;
const HARD_DIM = 320;
const HARD_PIXELS = 100000;
const DEFAULT_DIM = 256;
const SQRT2 = Math.SQRT2;
const STEPS = [[-1,0,1],[1,0,1],[0,-1,1],[0,1,1],[-1,-1,SQRT2],[1,-1,SQRT2],[-1,1,SQRT2],[1,1,SQRT2]];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function number(value, fallback, lo, hi, name, integer = false) {
  const n = value === undefined ? fallback : value;
  if (!Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n))) throw new RangeError(`Invalid ${name}`);
  return n;
}
function uv(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new RangeError('Anchor must be a finite image UV point in [0, 1]');
  return {x: point.x, y: point.y};
}
/** Takes existing RGBA data without making a source-sized copy; oversize inputs fail first.
 * limits: maxDimension (8..320, default 256), maxPixels (64..100000).
 * Returns gradients in 0..255 brightness units per reduced-image pixel.
 */
export function prepareGuidedImage(imageData, limits = {}) {
  const {width: sourceWidth, height: sourceHeight} = imageData || {};
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 2 || sourceHeight < 2 || sourceWidth > HARD_SOURCE_DIM || sourceHeight > HARD_SOURCE_DIM || sourceWidth * sourceHeight > HARD_SOURCE_PIXELS) throw new RangeError('Guided trace source must be 2..1024 pixels per dimension');
  const data = imageData.data;
  if (!(data instanceof Uint8ClampedArray || data instanceof Uint8Array) || data.length !== sourceWidth * sourceHeight * 4) throw new RangeError('Invalid guided trace RGBA data');
  const maxDimension = number(limits.maxDimension, DEFAULT_DIM, 8, HARD_DIM, 'maxDimension', true);
  const maxPixels = number(limits.maxPixels, 65536, 64, HARD_PIXELS, 'maxPixels', true);
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight), Math.sqrt(maxPixels / (sourceWidth * sourceHeight)));
  const width = Math.max(2, Math.floor(sourceWidth * scale));
  const height = Math.max(2, Math.floor(sourceHeight * scale));
  if (width * height > maxPixels) throw new RangeError('Image aspect ratio exceeds prepared pixel limit');
  const count = width * height;
  const gray = new Float32Array(count);
  // Area averaging uses the existing source only. Alpha composites over white, matching
  // the reference-image canvas, rather than manufacturing edges from hidden RGB values.
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sourceHeight / height), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sourceHeight / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sourceWidth / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sourceWidth / width));
      let sum = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * sourceWidth + sx) * 4, a = data[i + 3] / 255;
        const luminance = .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
        sum += a * luminance + (1 - a) * 255;
      }
      gray[y * width + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  const magnitude = new Float32Array(count), normalX = new Float32Array(count), normalY = new Float32Array(count);
  let maxGradient = 0;
  const sample = (x,y) => gray[clamp(y,0,height-1) * width + clamp(x,0,width-1)];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const gx = (sample(x+1,y-1)+2*sample(x+1,y)+sample(x+1,y+1)-sample(x-1,y-1)-2*sample(x-1,y)-sample(x-1,y+1))/8;
    const gy = (sample(x-1,y+1)+2*sample(x,y+1)+sample(x+1,y+1)-sample(x-1,y-1)-2*sample(x,y-1)-sample(x+1,y-1))/8;
    const i = y * width + x, g = Math.hypot(gx, gy);
    magnitude[i] = g;
    if (g > 0) { normalX[i] = gx/g; normalY[i] = gy/g; }
    maxGradient = Math.max(maxGradient, g);
  }
  return {kind: 'vectorforge-guided-image-v1', width, height, sourceWidth, sourceHeight, magnitude, normalX, normalY, maxGradient};
}

// Indexed binary heap: each pixel occupies at most one slot, unlike duplicate-entry
// priority queues whose memory can grow with every relaxation.
class PixelHeap {
  constructor(count, priority) { this.ids = new Int32Array(count); this.positions = new Int32Array(count).fill(-1); this.priority = priority; this.length = 0; }
  swap(a,b) { const t=this.ids[a]; this.ids[a]=this.ids[b]; this.ids[b]=t; this.positions[this.ids[a]]=a; this.positions[t]=b; }
  update(id) {
    let i=this.positions[id];
    if(i<0) { i=this.length++; this.ids[i]=id; this.positions[id]=i; }
    while(i>0) { const p=(i-1)>>1; if(this.priority[this.ids[p]] <= this.priority[id]) break; this.swap(i,p); i=p; }
  }
  pop() {
    const id=this.ids[0]; this.positions[id]=-1; this.length--;
    if(this.length) {
      this.ids[0]=this.ids[this.length]; this.positions[this.ids[0]]=0;
      let i=0;
      while(true) { const l=i*2+1,r=l+1; if(l>=this.length) break; const c=r<this.length&&this.priority[this.ids[r]]<this.priority[this.ids[l]]?r:l; if(this.priority[this.ids[i]]<=this.priority[this.ids[c]]) break; this.swap(i,c); i=c; }
    }
    return id;
  }
}
function lineDistance(x,y,ax,ay,bx,by) {
  const dx=bx-ax,dy=by-ay,d2=dx*dx+dy*dy;
  const t=d2 ? clamp(((x-ax)*dx+(y-ay)*dy)/d2,0,1) : 0;
  return Math.hypot(x-ax-t*dx,y-ay-t*dy);
}
// Local structure-tensor anisotropy: a coherent boundary has neighboring gradients
// pointing across the same edge, whereas texture/noise has mixed gradient directions.
// Sample only the final path, in fixed 5x5 neighborhoods, with no image-sized scratch.
function edgeCoherence(x,y,w,h,magnitude,normalX,normalY) {
  let xx=0,xy=0,yy=0;
  for(let sy=Math.max(0,y-2);sy<=Math.min(h-1,y+2);sy++) {
    for(let sx=Math.max(0,x-2);sx<=Math.min(w-1,x+2);sx++) {
      const id=sy*w+sx,g=magnitude[id],gx=g*normalX[id],gy=g*normalY[id];
      xx+=gx*gx;xy+=gx*gy;yy+=gy*gy;
    }
  }
  return xx+yy>1e-8 ? clamp(Math.hypot(xx-yy,2*xy)/(xx+yy),0,1) : 0;
}
// Iterative RDP, never more than one reduced-image pixel of geometric error.
function simplify(points, tolerance) {
  if(points.length<3 || tolerance===0) return points;
  const keep=new Uint8Array(points.length); keep[0]=keep[points.length-1]=1;
  const stack=[0,points.length-1];
  while(stack.length) {
    const end=stack.pop(),start=stack.pop(),a=points[start],b=points[end];
    let max=tolerance,index=-1;
    for(let i=start+1;i<end;i++) { const p=points[i],d=lineDistance(p.x,p.y,a.x,a.y,b.x,b.y); if(d>max) {max=d;index=i;} }
    if(index>=0) {keep[index]=1;stack.push(start,index,index,end);}
  }
  return points.filter((_,i)=>keep[i]);
}
/** Trace ONE open segment; a closed outline is explicit caller-owned last-to-first tracing.
 * options: corridorRadius (pixels, default local), maxExpanded (<=100000),
 * maxDetour (1..4, default 2.4), minGradient (default 7), simplifyTolerance (0..1),
 * signal (AbortSignal). No anchor snapping: exact input endpoints are preserved.
 * A failed/low-contrast search returns no points; an uncertain candidate may return points
 * for review, but callers must not silently treat it as a confident boundary.
 */
export function traceGuidedSegment(prepared, fromUV, toUV, options = {}) {
  if(prepared?.kind!=='vectorforge-guided-image-v1') throw new TypeError('Prepare the image before tracing');
  const {width:w,height:h,magnitude,normalX,normalY}=prepared, count=w*h;
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<2||h<2||w>HARD_DIM||h>HARD_DIM||count>HARD_PIXELS||magnitude?.length!==count||normalX?.length!==count||normalY?.length!==count) throw new RangeError('Invalid prepared image');
  const from=uv(fromUV),to=uv(toUV);
  const ax=Math.round(from.x*(w-1)), ay=Math.round(from.y*(h-1)), bx=Math.round(to.x*(w-1)), by=Math.round(to.y*(h-1));
  const straight=Math.hypot(bx-ax,by-ay), start=ay*w+ax, goal=by*w+bx;
  const radius=number(options.corridorRadius,clamp(straight*.3,8,36),2,96,'corridorRadius');
  const maxExpanded=number(options.maxExpanded,Math.min(count,45000),1,HARD_PIXELS,'maxExpanded',true);
  const maxDetour=number(options.maxDetour,2.4,1,4,'maxDetour');
  const minGradient=number(options.minGradient,7,1,64,'minGradient');
  const tolerance=number(options.simplifyTolerance,.65,0,1,'simplifyTolerance');
  let expanded=0;
  const fail=reason=>({pointsUV:[],confidence:0,uncertain:true,reason,stats:{expanded,width:w,height:h}});
  if(options.signal?.aborted) return fail('cancelled');
  if(start===goal) return fail('anchors-too-close');
  if(prepared.maxGradient<minGradient) return fail('low-contrast');
  const dist=new Float64Array(count).fill(Infinity), priority=new Float64Array(count).fill(Infinity), parent=new Int32Array(count).fill(-1), closed=new Uint8Array(count);
  const heap=new PixelHeap(count,priority);
  dist[start]=0; priority[start]=straight*.14; heap.update(start);
  const strongGradient=Math.max(20,minGradient*2);
  let reached=false;
  while(heap.length && expanded<maxExpanded) {
    if((expanded&255)===0 && options.signal?.aborted) return fail('cancelled');
    const id=heap.pop(); if(id===goal) {reached=true;break;}
    closed[id]=1; expanded++;
    const x=id%w,y=Math.floor(id/w);
    for(const [dx,dy,length] of STEPS) {
      const nx=x+dx,ny=y+dy;
      if(nx<0||ny<0||nx>=w||ny>=h) continue;
      const next=ny*w+nx;
      if(closed[next]) continue;
      const off=lineDistance(nx,ny,ax,ay,bx,by);
      if(off>radius || Math.hypot(nx-ax,ny-ay)+Math.hypot(nx-bx,ny-by)>straight*maxDetour+2) continue;
      const strength=Math.min(1,(magnitude[id]+magnitude[next])/(2*strongGradient));
      // A path should move ALONG the gradient tangent, not across the edge normal.
      const crossingA=Math.abs(normalX[id]*dx+normalY[id]*dy)/length;
      const crossingB=Math.abs(normalX[next]*dx+normalY[next]*dy)/length;
      const crossing=(crossingA*crossingA+crossingB*crossingB)*.5;
      const edgeCost=.14+3*(1-strength)*(1-strength)+1.7*strength*crossing+.025*off;
      const candidate=dist[id]+length*edgeCost;
      if(candidate<dist[next]) {dist[next]=candidate;parent[next]=id;priority[next]=candidate+.14*Math.hypot(nx-bx,ny-by);heap.update(next);}
    }
  }
  if(!reached) return fail(heap.length?'search-limit':'no-local-path');
  const path=[];
  for(let id=goal;id!==-1 && path.length<=count;id=parent[id]) {path.push({x:id%w,y:Math.floor(id/w),id});if(id===start)break;}
  if(path.at(-1)?.id!==start) return fail('no-local-path');
  path.reverse();
  let supported=0,quality=0,gap=0,longestGap=0,pathLength=0,coherenceSum=0,coherentPixels=0;
  for(let i=0;i<path.length;i++) {
    const g=magnitude[path[i].id];
    if(g>=minGradient) {
      supported++;gap=0;
      const coherence=edgeCoherence(path[i].x,path[i].y,w,h,magnitude,normalX,normalY);
      coherenceSum+=coherence;
      if(coherence>=.55) coherentPixels++;
    } else {gap++;longestGap=Math.max(gap,longestGap);}
    quality+=Math.min(1,g/strongGradient);
    if(i) pathLength+=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);
  }
  if(pathLength>straight*maxDetour+2) return fail('excessive-detour');
  const support=supported/path.length;
  const meanCoherence=supported?coherenceSum/supported:0,coherenceSupport=supported?coherentPixels/supported:0;
  const textureDominated=meanCoherence<.6||coherenceSupport<.65;
  const confidence=clamp((.6*support+.4*quality/path.length)*Math.sqrt(meanCoherence),0,1);
  const uncertain=support<.68||confidence<.65||textureDominated||longestGap>Math.max(5,path.length*.15);
  const reason=textureDominated?'texture-or-ambiguous-edge':uncertain?'weak-or-ambiguous-edge':null;
  // Coherence is a conservative texture warning, not proof that the selected edge
  // is unique or semantically correct. Parallel/structured textures still need review.
  // In a textureless corridor an arbitrary geodesic is not an image-derived trace.
  if(support<.2) return fail('low-contrast');
  const pointsUV=simplify(path,tolerance).map(p=>({x:p.x/(w-1),y:p.y/(h-1)}));
  pointsUV[0]=from;pointsUV[pointsUV.length-1]=to;
  return {pointsUV,confidence,uncertain,reason,stats:{expanded,width:w,height:h,pathPixels:path.length,pathLength,support,longestGap,meanCoherence,coherenceSupport}};
}
