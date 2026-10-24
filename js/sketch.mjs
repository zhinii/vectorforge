// Bounded, deterministic reconstruction. No recognition, upload, or model calls.
export const SKETCH_LIMIT = 100000;
export const MAX_SKETCH_VERTICES = 32;
const EPS = 1e-7;
const directions = {right:[1,0],up:[0,1],left:[-1,0],down:[0,-1]};
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (code, field) => { const e = Error(code); e.code = code; if(field)e.field = field; throw e; };
function num(v, field, {positive=false, limit=SKETCH_LIMIT}={}) {
  if(v===undefined||v===null||v==='')fail('sketch.underdetermined',field);
  if((typeof v!=='number'&&typeof v!=='string')||(typeof v==='string'&&!v.trim()))fail('sketch.invalid',field);
  const n=Number(v); if(!Number.isFinite(n)||Math.abs(n)>limit||(positive&&n<=EPS))fail('sketch.invalid',field);return n;
}
function point(p,field){if(!Array.isArray(p)||p.length!==2)fail('sketch.invalid',field);return p.map((x,i)=>num(x,field+'.'+i));}
function id(v,field){if(typeof v!=='string'||!/^[-\w]{1,100}$/.test(v))fail('sketch.invalid',field);return v;}
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function intersects(a,b,c,d){
  const values=[cross(a,b,c),cross(a,b,d),cross(c,d,a),cross(c,d,b)];
  const on=(p,q,r)=>Math.abs(cross(p,q,r))<EPS&&r[0]>=Math.min(p[0],q[0])-EPS&&r[0]<=Math.max(p[0],q[0])+EPS&&r[1]>=Math.min(p[1],q[1])-EPS&&r[1]<=Math.max(p[1],q[1])+EPS;
  return (values[0]*values[1]<0&&values[2]*values[3]<0)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
}
function profilePoints(edges){
  let p=[0,0];const points=[];
  for(let i=0;i<edges.length;i++){
    const edge=edges[i],previous=edges[(i+edges.length-1)%edges.length];
    if(directions[edge.direction][0]===0?directions[previous.direction][0]===0:directions[previous.direction][1]===0)fail('sketch.redundantCorner',`edges.${i}`);
    points.push(p);p=p.map((v,j)=>v+directions[edge.direction][j]*edge.length);
    if(p.some(v=>Math.abs(v)>SKETCH_LIMIT))fail('sketch.invalid','profile extent');
  }
  if(Math.hypot(...p)>EPS)fail('sketch.closureConflict','edges');
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){
    if(j===i+1||(i===0&&j===points.length-1))continue;
    if(intersects(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]))fail('sketch.selfIntersection','edges');
  }
  const area=points.reduce((s,p,i)=>{const q=points[(i+1)%points.length];return s+p[0]*q[1]-q[0]*p[1];},0)/2;
  if(Math.abs(area)<EPS)fail('sketch.zeroArea','edges');return points;
}
export function validateSketchSpec(input){
  if(!plain(input)||input.version!==1||!['line','circle','arc','rectangle','profile'].includes(input.kind))fail('sketch.invalid','spec');
  const spec={version:1,kind:input.kind,anchor:point(input.anchor,'anchor'),rotation:num(input.rotation,'rotation',{limit:360000})};
  if(input.referenceId!==undefined&&input.referenceId!==null)spec.referenceId=id(input.referenceId,'referenceId');
  if(input.landmarks!==undefined){if(!Array.isArray(input.landmarks)||input.landmarks.length>MAX_SKETCH_VERTICES)fail('sketch.invalid','landmarks');spec.landmarks=input.landmarks.map((p,i)=>point(p,'landmark '+i));}
  if(spec.kind==='profile'){
    if(!Array.isArray(input.edges)||input.edges.length<4||input.edges.length>MAX_SKETCH_VERTICES)fail('sketch.vertexLimit','edges');
    spec.edges=input.edges.map((e,i)=>{if(!plain(e)||!Object.hasOwn(directions,e.direction))fail('sketch.invalid','direction '+i);return {direction:e.direction,length:num(e.length,'edge '+(i+1),{positive:true})};});
    profilePoints(spec.edges);
  }else{
    if(!plain(input.dimensions))fail('sketch.underdetermined','dimensions');
    const keys={line:['length'],circle:['radius'],arc:['radius','startAngle','sweep'],rectangle:['width','height']}[spec.kind];spec.dimensions={};
    for(const key of keys)spec.dimensions[key]=num(input.dimensions[key],key,{positive:key!=='startAngle',limit:['startAngle','sweep'].includes(key)?360:SKETCH_LIMIT});
    if(spec.kind==='arc'&&spec.dimensions.sweep>=360)fail('sketch.arcSweep','sweep');
  }
  if(input.bindings!==undefined){
    if(!plain(input.bindings)||Object.keys(input.bindings).length>MAX_SKETCH_VERTICES)fail('sketch.invalid','bindings');
    spec.bindings={};for(const [key,value] of Object.entries(input.bindings)){
      if(!(spec.kind==='profile'?/^edge\.(\d+)$/.test(key)&&Number(key.slice(5))<spec.edges.length:Object.hasOwn(spec.dimensions,key)))fail('sketch.invalid','binding');
      spec.bindings[key]=id(value,'annotationId');
    }
  }
  return spec;
}
export function reconstructSketch(input,{group='sketch'}={}){
  const spec=validateSketchSpec(input);id(group,'group');
  const angle=spec.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const place=([x,y])=>{const p=[spec.anchor[0]+x*c-y*s,spec.anchor[1]+x*s+y*c];if(p.some(v=>!Number.isFinite(v)||Math.abs(v)>SKETCH_LIMIT))fail('sketch.invalid','geometry bounds');return p;};
  const meta={layer:'cut',group,name:'Dimension-driven '+spec.kind};let op;
  if(spec.kind==='line')op={op:'line',from:place([0,0]),to:place([spec.dimensions.length,0]),...meta};
  if(spec.kind==='circle'||spec.kind==='arc'){
    const {radius,startAngle,sweep}=spec.dimensions;
    // Bound full circle, conservatively, even for partial arcs.
    for(const p of [[radius,0],[-radius,0],[0,radius],[0,-radius]]){if(spec.anchor.some((x,i)=>Math.abs(x+p[i])>SKETCH_LIMIT))fail('sketch.invalid','geometry bounds');}
    op={op:spec.kind,center:spec.anchor.slice(),radius,...meta};
    if(spec.kind==='arc'){op.start=spec.rotation+startAngle;op.end=op.start+sweep;}
  }
  if(spec.kind==='rectangle'){const {width:w,height:h}=spec.dimensions;op={op:'path',points:[[0,0],[w,0],[w,h],[0,h]].map(place),closed:true,...meta};}
  if(spec.kind==='profile')op={op:'path',points:profilePoints(spec.edges).map(place),closed:true,...meta};
  return {spec,ops:[op],status:'confirmed',warnings:spec.kind==='line'||spec.kind==='arc'?['sketch.openGeometry']:[]};
}
/** Photo points supply direction proposals only, never dimension values. */
export function inferOrthogonalDirections(points){
  if(!Array.isArray(points)||points.length<4||points.length>MAX_SKETCH_VERTICES)fail('sketch.vertexLimit');
  const ps=points.map((p,i)=>point(p,'landmark '+i));const a=ps[0],b=ps[1];if(Math.hypot(b[0]-a[0],b[1]-a[1])<EPS)fail('sketch.invalid','first edge');
  const rotation=Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI,rad=rotation*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad);let uncertain=false;
  const edges=ps.map((p,i)=>{const q=ps[(i+1)%ps.length],dx=q[0]-p[0],dy=q[1]-p[1],x=dx*c+dy*s,y=-dx*s+dy*c;
    if(Math.hypot(x,y)<EPS)fail('sketch.invalid','landmark edge '+i);
    if(Math.min(Math.abs(x),Math.abs(y))/Math.max(Math.abs(x),Math.abs(y))>.3)uncertain=true;
    return {direction:Math.abs(x)>=Math.abs(y)?x>0?'right':'left':y>0?'up':'down',length:null};});
  return {anchor:a.slice(),rotation,edges,warnings:uncertain?['sketch.uncertainDirections']:[]};
}
/** Validate project metadata; stale groups are omitted, never resurrected. */
export function validateSketchRegistry(value={},entities){
  if(!plain(value)||Object.keys(value).length>200)fail('sketch.invalid','sketch registry');
  const result={};for(const [group,input] of Object.entries(value)){id(group,'group');const validated=reconstructSketch(input,{group}).spec;if(entities&&entities.some(e=>e.group===group)&&!sketchMatches(validated,group,entities))fail('sketch.stale','geometry');if(!entities||entities.some(e=>e.group===group))Object.defineProperty(result,group,{value:validated,enumerable:true,writable:true,configurable:true});}return result;
}
function sketchMatches(spec,group,entities){
  const actual=entities.filter(e=>e.group===group);if(actual.length!==1)return false;
  const e=actual[0],op=reconstructSketch(spec,{group}).ops[0];if(e.type!==op.op)return false;
  const near=(a,b)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<1e-6;
  const pair=(a,b)=>Array.isArray(a)&&a.length===2&&a.every((v,i)=>near(v,b[i]));
  if(e.type==='line')return pair(e.p1,op.from)&&pair(e.p2,op.to);
  if(e.type==='circle'||e.type==='arc')return pair(e.c,op.center)&&near(e.r,op.radius)&&(e.type!=='arc'||near(e.a0,op.start)&&near(e.a1,op.end));
  return e.closed===op.closed&&Array.isArray(e.points)&&e.points.length===op.points.length&&e.points.every((p,i)=>pair(p,op.points[i]));
}
/** Direct geometry edits detach the constraint recipe rather than lying about its dimensions. */
export function reconcileSketches(doc){
  const kept={};let removed=0;for(const [group,input] of Object.entries(doc.sketches||{})){
    try{const spec=validateSketchSpec(input);if(!sketchMatches(spec,group,doc.entities||[])){removed++;continue;}Object.defineProperty(kept,group,{value:spec,enumerable:true,writable:true,configurable:true});}catch{removed++;}
  }doc.sketches=kept;return removed;
}
