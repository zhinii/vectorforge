import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntity, entityPoints, dist } from '../js/model.mjs';
import { projectToSegment, nearestPointOnEntity, snapCandidates, snapPoint, nearbyMeasurements } from '../js/spatial.mjs';

const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
const pointClose=(a,b,eps=1e-9)=>{close(a[0],b[0],eps);close(a[1],b[1],eps);};
const circle=(x=0,y=0,r=5)=>makeEntity('circle',{center:[x,y],radius:r});
const line=(a,b)=>makeEntity('line',{from:a,to:b});
const arc=(start,end)=>makeEntity('arc',{center:[0,0],radius:5,start,end});
const measure=(a,b)=>nearbyMeasurements(a,[a,b])[0];

 test('finite projection clamps endpoints and handles degenerate segments',()=>{
  pointClose(projectToSegment([3,4],[0,0],[10,0]).point,[3,0]);
  const beyond=projectToSegment([15,4],[0,0],[10,0]);
  pointClose(beyond.point,[10,0]); close(beyond.rawT,1.5);
  pointClose(projectToSegment([15,4],[2,3],[2,3]).point,[2,3]);
 });
 test('circle outline is analytic at arbitrary angles and zoom',()=>{
  const e=circle(), angle=0.012345, expected=[5*Math.cos(angle),5*Math.sin(angle)];
  pointClose(nearestPointOnEntity([7*Math.cos(angle),7*Math.sin(angle)],e),expected,1e-12);
  const p=[expected[0]+0.00001,expected[1]];
  const hit=snapPoint(p,[e],{scale:100000,tolerancePx:2});
  assert.equal(hit.kind,'nearest'); close(dist(hit.point,e.c),5,1e-12);
 });
 test('tolerance is screen-space across zoom levels',()=>{
  const e=line([0,0],[100,0]);
  assert.ok(snapPoint([20,4],[e],{scale:2,tolerancePx:10}));
  assert.equal(snapPoint([20,4],[e],{scale:3,tolerancePx:10}),null);
  assert.ok(snapPoint([20,.004],[e],{scale:2000,tolerancePx:10}));
 });
 test('discrete endpoints and midpoints win over nearest outline; exclusions work',()=>{
  const e=line([0,0],[100,0]);
  assert.equal(snapPoint([4,0],[e],{tolerancePx:5}).kind,'endpoint');
  assert.equal(snapPoint([49,0],[e],{tolerancePx:5}).kind,'midpoint');
  assert.equal(snapPoint([4,0],[e],{tolerancePx:5,excludeIds:[e.id]}),null);
 });
 test('rect polygon and star expose vertices, edge midpoints, and center',()=>{
  for (const type of ['rect','polygon','star']) {
    const e=makeEntity(type),pts=entityPoints(e);
    const candidates=snapCandidates(pts[0],[e],{tolerancePx:1000});
    assert.ok(candidates.some(c=>c.kind==='endpoint'&&dist(c.point,pts[0])<1e-9));
    assert.ok(candidates.some(c=>c.kind==='midpoint'&&dist(c.point,[(pts[0][0]+pts[1][0])/2,(pts[0][1]+pts[1][1])/2])<1e-9));
    assert.ok(candidates.some(c=>c.kind==='center'));
  }
 });
 test('wrapped arcs use correct endpoint midpoint and bounded nearest point',()=>{
  const e=arc(300,60);
  pointClose(nearestPointOnEntity([10,0],e),[5,0]);
  const q=nearestPointOnEntity([-10,0],e);
  close(q[0],2.5); close(Math.abs(q[1]),Math.sqrt(75)/2);
  const mid=snapCandidates([5,0],[e],{tolerancePx:.001}).find(c=>c.kind==='midpoint');
  pointClose(mid.point,[5,0]);
  pointClose(nearestPointOnEntity([0,0],arc(90,180)),[0,5]);
  close(dist(nearestPointOnEntity([-9,0],arc(0,360)),[-5,0]),0);
 });
 test('perpendicular snaps must land on the finite segment and form nonzero lines',()=>{
  const e=line([0,0],[10,0]);
  const options={from:[4,5],mode:'perpendicular',tolerancePx:1};
  pointClose(snapPoint([4,.5],[e],options).point,[4,0]);
  assert.equal(snapPoint([10,0],[e],{...options,from:[15,5]}),null);
  assert.equal(snapPoint([4,0],[e],{...options,from:[4,0]}),null);
  assert.equal(snapPoint([4,0],[line([4,0],[4,0])],options),null);
 });
 test('tangents are exact, exterior only, and respect arc angle bounds',()=>{
  const e=circle(), from=[13,0], x=25/13,y=60/13;
  const hits=snapCandidates([x,y],[e],{from,mode:'tangent',tolerancePx:.01});
  assert.equal(hits.length,1); pointClose(hits[0].point,[x,y]);
  close((x-from[0])*x+y*y,0,1e-12);
  assert.equal(snapPoint([x,y],[e],{from:[2,0],mode:'tangent',tolerancePx:100}),null);
  assert.equal(snapPoint([x,y],[e],{from:[5,0],mode:'tangent',tolerancePx:100}),null);
  assert.equal(snapPoint([x,y],[arc(180,270)],{from,mode:'tangent',tolerancePx:100}),null);
  assert.ok(snapPoint([x,y],[arc(0,90)],{from,mode:'tangent',tolerancePx:.01}));
 });
 test('selected circle has exact center distance and circumference-to-line gap',()=>{
  const a=circle(), b=line([-10,8],[10,8]), m=measure(a,b);
  close(m.centerDistance,8); close(m.clearance,3);
  pointClose(m.centerFrom,[0,0]);pointClose(m.centerTo,[0,8]);
  pointClose(m.from,[0,5]);pointClose(m.to,[0,8]);
  assert.equal(m.sourceId,a.id);assert.equal(m.targetId,b.id);
 });
 test('circle finite-endpoint measurements do not use extended lines',()=>{
  const m=measure(circle(),line([8,6],[20,6]));
  close(m.centerDistance,10);close(m.clearance,5);
  pointClose(m.from,[4,3]);pointClose(m.to,[8,6]);
 });
 test('intersections and tangencies have zero clearance with actual coincident points',()=>{
  for (const b of [line([-10,0],[10,0]),line([-10,5],[10,5]),circle(8,0,5),circle(10,0,5)]) {
    const m=measure(circle(),b);close(m.clearance,0);pointClose(m.from,m.to);close(dist(m.from,[0,0]),5);
  }
 });
 test('segments wholly inside circles measure boundary gap, not negative or sampled gaps',()=>{
  const m=measure(circle(),line([-1,0],[2,0]));
  close(m.centerDistance,0);close(m.clearance,3);pointClose(m.from,[5,0]);pointClose(m.to,[2,0]);
  const zero=measure(circle(),line([0,0],[0,0]));close(zero.clearance,5);
 });
 test('arc measurements respect bounded sweep, including wrap and zero sweep',()=>{
  const m=measure(arc(0,90),line([-10,-10],[-10,10]));
  close(m.clearance,10);pointClose(m.from,[0,5]);pointClose(m.to,[-10,5]);
  const wrapped=measure(arc(300,60),line([8,-10],[8,10]));close(wrapped.clearance,3);
  const zero=measure(arc(90,90),line([-10,0],[10,0]));close(zero.clearance,5);
 });
 test('circle pairs handle separation, containment, concentricity and bounded arcs',()=>{
  close(measure(circle(),circle(20,0,3)).clearance,12);
  close(measure(circle(),circle(1,0,2)).clearance,2);
  close(measure(circle(),circle(0,0,2)).clearance,3);
  close(measure(arc(0,90),arc(180,270)).clearance,Math.sqrt(50));
  close(measure(arc(300,60),arc(0,90)).clearance,0);
 });
 test('non-circular source segment measurements are exact and never invent center distances',()=>{
  const m=measure(line([0,0],[10,0]),line([4,-5],[4,5]));close(m.clearance,0);pointClose(m.from,[4,0]);
  assert.equal(m.centerDistance,null);assert.equal(m.centerFrom,null);
  close(measure(line([-10,8],[10,8]),circle()).clearance,3);
 });
 test('nearby edges are bounded and deterministic, with individual polygon edges',()=>{
  const a=circle(), near=line([-10,7],[10,7]),far=line([-10,20],[10,20]);
  const rows=nearbyMeasurements(a,[a,far,near],{limit:3,maxDistance:4});
  assert.equal(rows.length,1);assert.equal(rows[0].targetId,near.id);
  const rectangle=makeEntity('rect',{center:[0,0],width:20,height:20});
  const edges=nearbyMeasurements(a,[a,rectangle],{limit:4});
  assert.equal(edges.length,4);assert.equal(new Set(edges.map(m=>m.id)).size,4);edges.forEach(m=>close(m.clearance,5));
  assert.equal(nearbyMeasurements(a,[near],{limit:0}).length,0);
 });
 test('cubic Bezier snaps use true endpoint and t=.5 point, never control polygon or fake constraints',()=>{
  const b={id:'b',type:'bezier',p1:[0,0],c1:[0,8],c2:[8,8],p2:[8,0]};
  pointClose(snapPoint([4,6],[b],{tolerancePx:.01}).point,[4,6]);
  assert.equal(snapPoint([4,6],[b],{tolerancePx:.01}).kind,'midpoint');
  assert.equal(snapPoint([0,8],[b],{tolerancePx:.01}),null);
  assert.equal(snapPoint([4,6],[b],{mode:'perpendicular',from:[4,10]}),null);
  assert.ok(nearestPointOnEntity([0,8],b));
  assert.equal(snapPoint([4,8],[b],{tolerancePx:.01}),null);
  assert.equal(snapPoint([4,6],[b],{mode:'tangent',from:[4,10]}),null);
  assert.deepEqual(nearbyMeasurements(circle(),[b]),[]);assert.deepEqual(nearbyMeasurements(b,[circle()]),[]);
 });
 test('helpers are read-only, finite for coincident geometry, and reject nonfinite pointers',()=>{
  const entities=[circle(),arc(0,0),line([0,0],[0,0])],before=JSON.stringify(entities);
  for (const e of entities) for (const m of nearbyMeasurements(e,entities)) {
    assert.ok(Number.isFinite(m.clearance));assert.ok(m.from.every(Number.isFinite));assert.ok(m.to.every(Number.isFinite));
  }
  snapCandidates([0,0],entities,{from:[0,0],scale:0});
  assert.equal(JSON.stringify(entities),before);
  assert.equal(snapPoint([NaN,0],entities),null);
  assert.equal(nearestPointOnEntity([Infinity,0],entities[0]),null);
 });

// Independent Bernstein evaluation for known curve points and test oracles.
const cubicAt=(e,t)=>[0,1].map(i=>(1-t)**3*e.p1[i]+3*(1-t)**2*t*e.c1[i]+3*(1-t)*t*t*e.c2[i]+t**3*e.p2[i]);
const cubic=(p1,c1,c2,p2)=>({id:'cubic',type:'bezier',p1,c1,c2,p2});
const parabola=cubic([0,0],[100/3,0],[200/3,100/3],[100,100]);

test('Bezier nearest snaps cover arbitrary parameters, using screen tolerance at extreme zoom',()=>{
  for (const scale of [.25,1,10000,1e8]) {
    const t=.237,expected=cubicAt(parabola,t),normal=[-2*t,1],length=Math.hypot(...normal);
    const pointer=expected.map((v,i)=>v+normal[i]/length*2/scale);
    const hit=snapPoint(pointer,[parabola],{scale,tolerancePx:3});
    assert.equal(hit.kind,'nearest');
    assert.ok(dist(hit.point,expected)*scale<.01,`foot error at scale ${scale}`);
    close(hit.distancePx,2,.001);
    assert.equal(snapPoint(pointer,[parabola],{scale,tolerancePx:1}),null);
    assert.equal(snapPoint(pointer,[parabola],{scale,tolerancePx:3,excludeIds:[parabola.id]}),null);
    pointClose(nearestPointOnEntity(pointer,parabola,{scale}),expected,.01/scale);
  }
});

test('Bezier nearest does not displace endpoint/midpoint priority or mutate geometry',()=>{
  const b=cubic([0,0],[0,80],[80,80],[80,0]),before=JSON.stringify(b);
  assert.equal(snapPoint([.1,.1],[b],{tolerancePx:1}).kind,'endpoint');
  assert.equal(snapPoint([40,60.1],[b],{tolerancePx:1}).kind,'midpoint');
  const hits=snapCandidates([40,60.1],[b],{tolerancePx:1});
  assert.ok(hits.some(c=>c.kind==='nearest'));
  nearestPointOnEntity([-100,-100],b)[0]=999;
  assert.equal(JSON.stringify(b),before);
});

test('adaptive Bezier search handles closed loops and competing nearest branches',()=>{
  const loop=cubic([0,0],[200,300],[-200,300],[0,0]);
  for (const pointer of [[20,80],[-20,80],[0,150],[5,-10],[0,225]]) {
    const actual=nearestPointOnEntity(pointer,loop,{scale:100});
    // Dense sampling is only a test oracle, not the implementation. Refine the
    // best sample independently with golden-section distance minimization.
    let index=0,best=Infinity;
    for (let i=0;i<=4000;i++) {
      const d=dist(pointer,cubicAt(loop,i/4000));
      if (d<best) {best=d;index=i;}
    }
    let lo=Math.max(0,(index-1)/4000),hi=Math.min(1,(index+1)/4000);
    for (let i=0;i<70;i++) {
      const a=hi-(hi-lo)*.6180339887498949,b=lo+(hi-lo)*.6180339887498949;
      if (dist(pointer,cubicAt(loop,a))<dist(pointer,cubicAt(loop,b))) hi=b; else lo=a;
    }
    const reference=Math.min(dist(pointer,cubicAt(loop,(lo+hi)/2)),dist(pointer,loop.p1),dist(pointer,loop.p2));
    close(dist(pointer,actual),reference,1e-7);
  }
  const expected=cubicAt(loop,.1937);
  const hit=snapPoint(expected,[loop],{scale:1e7,tolerancePx:1});
  assert.equal(hit.kind,'nearest');assert.ok(dist(hit.point,expected)*1e7<.01);
});

test('Bezier cusp, collinear reversal and collapsed curves remain finite and snappable',()=>{
  // x=1000(t-.3)^2 and y=1000(t-.3)^3 have a non-midpoint cusp.
  const cusp=cubic([90,-27],[-110,63],[70/3,-147],[490,343]);
  const hit=snapPoint([-1e-8,0],[cusp],{scale:1e8,tolerancePx:2});
  assert.equal(hit.kind,'nearest');assert.ok(dist(hit.point,[0,0])*1e8<.01);
  const reversed=cubic([0,0],[300,0],[-300,0],[0,0]);
  pointClose(nearestPointOnEntity([50,1],reversed),[50,0],1e-6);
  assert.equal(snapPoint([50,1],[reversed],{tolerancePx:2}).kind,'nearest');
  const collapsed=cubic([2,3],[2,3],[2,3],[2,3]);
  pointClose(nearestPointOnEntity([7,9],collapsed),[2,3]);
  assert.equal(snapPoint([2,3],[collapsed],{tolerancePx:0}).kind,'endpoint');
  assert.equal(snapPoint([10,10],[collapsed],{tolerancePx:1}),null);
});

test('Bezier search tolerates tiny geometry, translated coordinates, and malformed controls',()=>{
  for (const [factor,offset,scale] of [[1e-8,0,1e10],[1,1e9,100]]) {
    const transformed=Object.fromEntries(['p1','c1','c2','p2'].map(k=>[k,parabola[k].map(v=>v*factor+offset)]));
    const b={id:'transformed',type:'bezier',...transformed},expected=cubicAt(b,.27183);
    const hit=snapPoint(expected,[b],{scale,tolerancePx:1});
    assert.equal(hit.kind,'nearest');assert.ok(dist(hit.point,expected)*scale<.01);
  }
  const malformed={...parabola,c1:[Infinity,0]};
  assert.equal(nearestPointOnEntity([20,20],malformed),null);
  assert.equal(snapPoint([20,20],[malformed],{tolerancePx:.01}),null);
});
