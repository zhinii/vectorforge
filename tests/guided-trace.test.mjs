import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGuidedImage, traceGuidedSegment} from '../js/guided-trace.mjs';

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const color=pixel(x,y),i=(y*width+x)*4;
    data.set(Array.isArray(color)?color:[color,color,color,255],i);
  }
  return {width,height,data};
}
const point=(x,y,w=144,h=112)=>({x:x/(w-1),y:y/(h-1)});
const pixels=(result,w,h)=>result.pointsUV.map(p=>({x:p.x*(w-1),y:p.y*(h-1)}));
const curve=x=>50+18*Math.sin(Math.PI*(x-20)/100);

for(const inverted of [false,true]) test(`livewire follows a curved ${inverted?'light-on-dark':'dark-on-light'} pixel boundary, not its straight chord`,()=>{
  const prepared=prepareGuidedImage(image(144,112,(x,y)=>(y>=curve(x))!==inverted?240:15));
  const from=point(20,50),to=point(120,50),result=traceGuidedSegment(prepared,from,to);
  assert.equal(result.uncertain,false,result.reason);
  assert.ok(result.confidence>.85);
  assert.deepEqual(result.pointsUV[0],from);assert.deepEqual(result.pointsUV.at(-1),to);
  const points=pixels(result,144,112);
  assert.ok(points.length>4,'must retain the curvature');
  assert.ok(Math.max(...points.map(p=>p.y))>65,'must follow pixels away from the straight anchor chord');
  assert.ok(points.every(p=>Math.abs(p.y-curve(p.x))<2.5),'path must stay on the photographed boundary');
});

test('an angular step stays on its visible boundary',()=>{
  const boundary=x=>x<48?36:x<80?56:36;
  const prepared=prepareGuidedImage(image(128,96,(x,y)=>y>=boundary(x)?0:255));
  const r=traceGuidedSegment(prepared,point(20,36,128,96),point(108,36,128,96));
  assert.equal(r.uncertain,false,r.reason);
  const pts=pixels(r,128,96);
  assert.ok(pts.some(p=>p.x>=50&&p.x<=77&&p.y>53));
  assert.ok(pts.every(p=>Math.abs(p.y-boundary(p.x))<2.5||Math.abs(p.x-48)<2||Math.abs(p.x-80)<2));
});

test('a stronger nearby competing edge does not steal the selected boundary',()=>{
  const prepared=prepareGuidedImage(image(180,110,(_x,y)=>y<40?80:y<57?140:255));
  const r=traceGuidedSegment(prepared,point(16,40,180,110),point(164,40,180,110));
  assert.equal(r.uncertain,false,r.reason);
  assert.ok(pixels(r,180,110).every(p=>Math.abs(p.y-40)<=1));
});

test('an unrelated strong edge outside a blank local corridor is not invented as a trace',()=>{
  const prepared=prepareGuidedImage(image(144,112,(_x,y)=>y<95?30:240));
  const r=traceGuidedSegment(prepared,point(20,30),point(120,30));
  assert.equal(r.uncertain,true);assert.equal(r.reason,'low-contrast');assert.deepEqual(r.pointsUV,[]);
});

test('flat or very weak images return an explicit no-edge result',()=>{
  for(const contrast of [0,3,10]) {
    const prepared=prepareGuidedImage(image(144,112,(x,y)=>y>=curve(x)?100+contrast:100));
    const r=traceGuidedSegment(prepared,point(20,50),point(120,50));
    assert.equal(r.uncertain,true);assert.equal(r.reason,'low-contrast');assert.deepEqual(r.pointsUV,[]);
  }
});

test('a long missing portion of a boundary is uncertain, not silently approved',()=>{
  const prepared=prepareGuidedImage(image(144,112,(x,y)=>x>=57&&x<83?120:y>=50?230:10));
  const r=traceGuidedSegment(prepared,point(20,50),point(120,50));
  assert.equal(r.uncertain,true);assert.ok(r.reason);assert.ok(r.confidence<1);
});

test('segments remain open; an explicit final segment can close an outline without doubling edges',()=>{
  const w=128,h=128,cx=64,cy=64,radius=35;
  const prepared=prepareGuidedImage(image(w,h,(x,y)=>Math.hypot(x-cx,y-cy)<=radius?15:245));
  const anchors=[[99,64],[64,99],[29,64],[64,29]].map(([x,y])=>point(x,y,w,h));
  for(let i=0;i<4;i++) {
    const a=anchors[i],b=anchors[(i+1)%4],r=traceGuidedSegment(prepared,a,b);
    assert.equal(r.uncertain,false,r.reason);assert.deepEqual(r.pointsUV[0],a);assert.deepEqual(r.pointsUV.at(-1),b);
    assert.notDeepEqual(r.pointsUV[0],r.pointsUV.at(-1));
    assert.ok(pixels(r,w,h).every(p=>Math.abs(Math.hypot(p.x-cx,p.y-cy)-radius)<2));
  }
});

test('preparation downsamples and bounds all arrays without a full source copy',()=>{
  const prepared=prepareGuidedImage(image(1024,1024,(x,y)=>y>x?0:255));
  assert.equal(prepared.width,256);assert.equal(prepared.height,256);
  for(const key of ['magnitude','normalX','normalY']) assert.equal(prepared[key].length,65536);
  const custom=prepareGuidedImage(image(1024,512,()=>80),{maxDimension:320,maxPixels:100000});
  assert.equal(custom.width,320);assert.equal(custom.height,160);
  const pixelBound=prepareGuidedImage(image(300,300,()=>80),{maxDimension:320,maxPixels:10000});
  assert.equal(pixelBound.width*pixelBound.height,10000);
  const inaccessible={width:2048,height:2048,get data(){throw new Error('must not inspect oversized data');}};
  assert.throws(()=>prepareGuidedImage(inaccessible),/1024/);
  // Width/dimensions must reject oversized input even if a source buffer has not been provided.
  assert.throws(()=>prepareGuidedImage({width:2048,height:2048,data:null}),/1024/);
  assert.throws(()=>prepareGuidedImage({width:2,height:2,data:new Uint8ClampedArray(3)}),/RGBA/);
  assert.throws(()=>prepareGuidedImage(image(8,8,()=>0),{maxDimension:321}),/maxDimension/);
  assert.throws(()=>prepareGuidedImage(image(8,8,()=>0),{maxPixels:100001}),/maxPixels/);
});

test('invalid anchors/options, too-close taps, cancellation, and exhausted search are bounded',()=>{
  const prepared=prepareGuidedImage(image(144,112,(x,y)=>y>=curve(x)?240:15)),from=point(20,50),to=point(120,50);
  for(const p of [{x:NaN,y:0},{x:2,y:.5},{x:.5,y:-1},null]) assert.throws(()=>traceGuidedSegment(prepared,p,to),/Anchor/);
  for(const options of [{maxExpanded:0},{maxExpanded:100001},{maxDetour:5},{simplifyTolerance:1.1},{corridorRadius:100},{minGradient:NaN}]) assert.throws(()=>traceGuidedSegment(prepared,from,to,options));
  assert.equal(traceGuidedSegment(prepared,from,from).reason,'anchors-too-close');
  const exhausted=traceGuidedSegment(prepared,from,to,{maxExpanded:1});
  assert.equal(exhausted.reason,'search-limit');assert.equal(exhausted.stats.expanded,1);assert.deepEqual(exhausted.pointsUV,[]);
  const controller=new AbortController();controller.abort();
  assert.equal(traceGuidedSegment(prepared,from,to,{signal:controller.signal}).reason,'cancelled');
});

test('fractional input anchors remain exact and UV traces are deterministic',()=>{
  const prepared=prepareGuidedImage(image(144,112,(x,y)=>y>=curve(x)?240:15));
  const from=point(20.25,50.2),to=point(119.8,50.1);
  const a=traceGuidedSegment(prepared,from,to),b=traceGuidedSegment(prepared,from,to);
  assert.deepEqual(a,b);assert.deepEqual(a.pointsUV[0],from);assert.deepEqual(a.pointsUV.at(-1),to);
  assert.ok(a.pointsUV.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1));
});


test('fully transparent hidden colors do not manufacture boundaries',()=>{
  const prepared=prepareGuidedImage(image(144,112,(x,y)=>y>=curve(x)?[0,0,0,0]:[255,255,255,0]));
  assert.equal(prepared.maxGradient,0);
  assert.deepEqual(traceGuidedSegment(prepared,point(20,50),point(120,50)).pointsUV,[]);
});


test('deterministic grayscale texture is uncertain despite abundant gradients',()=>{
  for(const size of [256,1024]) {
    let seed=0x52346;
    const noisy=image(size,size,()=>{
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      return seed>>>24;
    });
    const prepared=prepareGuidedImage(noisy);
    const result=traceGuidedSegment(prepared,{x:.1,y:.1},{x:.9,y:.9});
    assert.equal(result.uncertain,true,`random ${size}px noise must not be presented as a reliable boundary`);
    assert.ok(['texture-or-ambiguous-edge','low-contrast','search-limit'].includes(result.reason),result.reason);
    assert.ok(result.confidence<.65);
    if(result.stats.meanCoherence!==undefined) assert.ok(result.stats.meanCoherence<.6);
  }
});
