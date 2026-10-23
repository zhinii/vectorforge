import test from 'node:test';
import assert from 'node:assert/strict';
import {traceRaster} from '../js/import.mjs';
const image=rows=>({width:rows[0].length,height:rows.length,data:new Uint8ClampedArray(rows.flatMap(row=>[...row].flatMap(c=>c==='#'?[0,0,0,255]:[255,255,255,255])))});
const signed=p=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length];return sum+a[0]*b[1]-b[0]*a[1];},0)/2;
const trace=(rows,opt={})=>traceRaster(image(rows),{minArea:1,...opt});

test('trace returns exact rectangle in y-up millimetres',()=>{
  const r=trace(['.....','.###.','.###.','.....'],{mmPerPixel:2});
  assert.equal(r.ops.length,1);assert.equal(r.ops[0].points.length,4);assert.equal(r.ops[0].hole,false);
  assert.deepEqual(r.bounds,{minX:2,minY:2,maxX:8,maxY:6,width:6,height:4});
  assert.equal(r.foregroundPixels,6);assert.equal(signed(r.ops[0].points),-24);
});
test('trace preserves donut holes, winding, and nested islands',()=>{
  const r=trace(['#######','#.....#','#.###.#','#.#.#.#','#.###.#','#.....#','#######']);
  assert.equal(r.ops.length,4);assert.equal(r.ops.filter(o=>o.hole).length,2);
  for(const op of r.ops)assert.equal(signed(op.points)>0,op.hole);
  assert.equal(r.ops.reduce((n,op)=>n-signed(op.points),0),r.foregroundPixels);
});
test('diagonally touching foreground remains separate, not an accidental bridge',()=>{
  const r=trace(['#.','.#']);assert.equal(r.ops.length,2);assert.ok(r.ops.every(op=>!op.hole&&op.points.length===4));
  const q=trace(['.#.','#.#','.#.']);assert.equal(q.ops.length,4);
});
test('one-pixel strokes survive default cleanup and simplify does not collapse them',()=>{
  const r=trace(['........','..#.....','..#.....','..####..','........'],{simplify:20});
  assert.equal(r.ops.length,1);assert.equal(r.foregroundPixels,6);assert.equal(Math.abs(signed(r.ops[0].points)),6);
  assert.ok(r.warnings.some(s=>s.includes('0.49')));
  const clean=trace(['........','..#.....','..#.....','..####..','........'],{cleanup:1});
  assert.ok(clean.foregroundPixels<r.foregroundPixels);assert.ok(clean.warnings.some(s=>s.includes('thin strokes')));
});
test('minimum area removes specks without filling holes',()=>{
  const r=trace(['#.......','.#####..','.#...#..','.#####..','.......#'],{minArea:4});
  assert.equal(r.ops.length,2);assert.equal(r.ops.filter(o=>o.hole).length,1);assert.equal(r.removedPixels,2);
});
test('inversion treats white foreground correctly and transparency is always background',()=>{
  const source=image(['###','#.#','###']);
  const r=traceRaster(source,{invert:true,minArea:1});assert.equal(r.foregroundPixels,1);assert.equal(r.ops.length,1);
  const transparent={width:2,height:1,data:new Uint8ClampedArray([0,0,0,0,255,255,255,255])};
  assert.equal(traceRaster(transparent,{minArea:1}).foregroundPixels,0);
  assert.equal(traceRaster(transparent,{minArea:1,invert:true}).foregroundPixels,1);
});
test('adaptive threshold runs locally and leaves flat backgrounds empty',()=>{
  const r=trace(['.....','..#..','.....'],{thresholdMode:'adaptive',adaptiveWindow:3});assert.equal(r.foregroundPixels,1);
  const q=trace(['.....','.....'],{thresholdMode:'adaptive'});assert.equal(q.ops.length,0);
});
test('empty foreground returns a useful warning rather than invented vectors',()=>{
  const r=trace(['....','....']);assert.deepEqual(r.ops,[]);assert.equal(r.bounds,null);assert.ok(r.warnings.some(s=>s.includes('No foreground')));
});
test('raster input, options, point and contour complexity are bounded',()=>{
  for(const opt of [{threshold:NaN},{threshold:256},{cleanup:3},{minArea:-1},{simplify:Infinity},{mmPerPixel:0},{thresholdMode:'unknown'}])assert.throws(()=>trace(['##','##'],opt));
  assert.throws(()=>traceRaster({width:1025,height:1,data:new Uint8ClampedArray(4100)}));
  assert.throws(()=>traceRaster({width:2,height:2,data:new Uint8ClampedArray(3)}));
  const noisy=Array.from({length:80},(_,y)=>Array.from({length:80},(_,x)=>(x+y)%2?'#':'.').join(''));
  assert.throws(()=>trace(noisy),/contours|points/);
});
test('deterministic random small masks preserve exact area without simplification',()=>{
  let seed=7;
  for(let n=0;n<150;n++) {
    const rows=Array.from({length:12},()=>Array.from({length:12},()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%5<2?'#':'.';}).join(''));
    const r=trace(rows,{simplify:0});
    assert.equal(r.ops.reduce((n,op)=>n-signed(op.points),0),r.foregroundPixels);
    assert.ok(r.ops.every(op=>op.closed&&op.points.length>=3));
  }
});
