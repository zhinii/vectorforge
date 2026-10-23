import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSVG,inspectRaster} from '../js/import.mjs';
const svg = (body,attrs='width="100mm" height="100mm" viewBox="0 0 100 100"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const near=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);

test('SVG explicit millimetres, viewBox origin, and y-up conversion',()=>{
  const r=parseSVG(svg('<rect x="10" y="20" width="30" height="40"/>'));
  assert.deepEqual(r.ops[0].points,[[10,80],[40,80],[40,40],[10,40]]);
  assert.deepEqual(r.bounds,{minX:10,minY:40,maxX:40,maxY:80,width:30,height:40});
  assert.equal(r.ops[0].layer,'cut');assert.equal(r.ops[0].closed,true);
  const o=parseSVG(svg('<line x1="10" y1="20" x2="110" y2="120"/>','width="100mm" height="100mm" viewBox="10 20 100 100"'));
  assert.deepEqual(o.ops[0].points,[[0,100],[100,0]]);
});
test('SVG 96 dpi unit conversion and default aspect ratio meet',()=>{
  const r=parseSVG(svg('<rect width="96" height="96"/>','width="96px" height="1in"'));
  near(r.bounds.width,25.4);near(r.bounds.height,25.4);
  const p=parseSVG(svg('<rect width="100" height="100"/>','width="200mm" height="100mm" viewBox="0 0 100 100"'));
  assert.deepEqual(p.bounds,{minX:50,maxX:150,minY:0,maxY:100,width:100,height:100});
  const q=parseSVG(svg('<rect width="100" height="100"/>','width="200mm" height="100mm" viewBox="0 0 100 100" preserveAspectRatio="none"'));
  assert.equal(q.bounds.width,200);
});
test('SVG nested transforms follow SVG composition order',()=>{
  const r=parseSVG(svg('<g transform="translate(10 20)"><g transform="scale(2)"><line x1="0" y1="0" x2="10" y2="5"/></g></g>'));
  assert.deepEqual(r.ops[0].points,[[10,80],[30,70]]);
  const q=parseSVG(svg('<line x1="1" y1="0" x2="2" y2="0" transform="rotate(90)"/>'));
  near(q.ops[0].points[0][0],0);near(q.ops[0].points[0][1],99);
});
test('SVG path absolute/relative M L H V C Q Z and disjoint subpaths',()=>{
  const r=parseSVG(svg('<path d="M 10 10 h 10 v 10 l -10 0 z M30 30 C30 50 50 50 50 30 Q40 20 30 30 Z"/>'));
  assert.equal(r.ops.length,2);assert.deepEqual(r.ops[0].points,[[10,90],[20,90],[20,80],[10,80]]);
  assert.ok(r.ops[1].points.length>10);assert.ok(r.ops.every(op=>op.points.every(p=>p.every(Number.isFinite))));
  assert.ok(!r.ops[1].points.some((p,i)=>i&&p[0]===r.ops[1].points[i-1][0]&&p[1]===r.ops[1].points[i-1][1]));
});
test('SVG handles all allowlisted geometry and fill-rule hole metadata',()=>{
  const r=parseSVG(svg('<polygon points="0,0 10,0 0,10"/><polyline points="0,0 2,3"/><circle cx="20" cy="20" r="5"/><ellipse cx="40" cy="40" rx="10" ry="5"/>'));
  assert.equal(r.ops.length,4);assert.equal(r.ops[1].closed,false);
  const holes=parseSVG(svg('<path fill-rule="evenodd" d="M0 0H30V30H0Z M10 10H20V20H10Z"/>'));
  assert.equal(holes.ops[0].hole,false);assert.equal(holes.ops[1].hole,true);
  const nz=parseSVG(svg('<path d="M0 0H30V30H0Z M10 10V20H20V10Z"/>'));
  assert.equal(nz.ops[1].hole,true);
});
test('SVG XML comments and inert title/description are not inserted into a DOM',()=>{
  const r=parseSVG('<?xml version="1.0"?>'+svg('<title>Test</title><!-- fine --><desc>local geometry</desc><line x2="3" y2="4"/>'));
  assert.equal(r.ops.length,1);
});
test('SVG rejects active content, CSS, XML expansion, references, and foreign namespaces',()=>{
  for(const bad of [
    '<!DOCTYPE svg [<!ENTITY x "boom">]>'+svg('<path d="&x;"/>'),
    svg('<script>alert(1)</script>'),svg('<SCRIPT/>'),svg('<foreignObject/>'),
    svg('<rect width="1" height="1" onload="alert(1)"/>'),
    svg('<g style="display:none"><rect width="1" height="1"/></g>'),
    svg('<style>path{fill:red}</style>'),svg('<use href="https://evil.test/a.svg"/>'),
    svg('<image href="data:image/svg+xml;base64,x"/>'),svg('<path fill="url(https://evil.test/x)" d="M0 0L1 1"/>'),
    svg('<a href="file:///etc/passwd"><line x2="1"/></a>'),
    svg('<line x2="1" xlink:href="x"/>'),svg('<svg:line x2="1"/>'),
    svg('<line x2="&#49;"/>'),svg('<![CDATA[<script>]]>'),
    '<?xml-stylesheet href="https://evil.test/a"?>'+svg('<line x2="1"/>'),
  ])assert.throws(()=>parseSVG(bad),undefined,bad);
});
test('SVG unsupported visual features reject whole import rather than partial success',()=>{
  for(const tail of ['<text>Label</text>','<path d="M0 0A5 5 0 0 1 5 5"/>','<path d="M0 0S5 5 10 10"/>','<rect width="5" height="5" rx="1"/>','<g clip-path="url(#clip)"/>','<g opacity="0"/>','<defs/>','<g display="none"/>']) {
    assert.throws(()=>parseSVG(svg('<line x2="1"/>'+tail)));
  }
  for(const attrs of ['width="100%" height="100mm"','width="-2"','viewBox="0 0 0 1"','viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice"'])assert.throws(()=>parseSVG(svg('<line x2="1"/>',attrs)));
});
test('SVG malformed input, singular transforms and work budgets are bounded',()=>{
  for(const s of [svg('<line x2="1" x2="2"/>'),'<svg><g></svg>',svg('<path d="M0 0L"/>'),svg('<line x2="Infinity"/>'),svg('<line x2="1e99"/>'),svg('<line x2="1" transform="scale(0)"/>'),svg('<line x2="1" transform="matrix(1 2 2 4 0 0)"/>'),svg('<g>'.repeat(33)+'<line x2="1"/>'+'</g>'.repeat(33)),svg('<rect width="2" height="3"/>')+'junk','x'.repeat(2*1024*1024+1)])assert.throws(()=>parseSVG(s));
  assert.throws(()=>parseSVG(svg('<circle r="1000"/>'),{maxPoints:3}));
  assert.throws(()=>parseSVG(svg(`<polyline points="${Array.from({length:4097},(_,i)=>`${i},${i%2}`).join(' ')}"/>`)));
  assert.throws(()=>parseSVG(svg('<line x2="2"/>'),{layer:'laser'}));
});
function png(w,h) {const b=new Uint8Array(33);b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);const d=new DataView(b.buffer);d.setUint32(16,w);d.setUint32(20,h);return b;}
test('raster preflight validates signatures and bounded decoded dimensions',()=>{
  assert.deepEqual(inspectRaster(png(100,200)),{width:100,height:200,mime:'image/png'});
  const jpeg=new Uint8Array(30);jpeg.set([255,216,255,224,0,4,0,0,255,192,0,17,8,0,20,0,30,3]);
  assert.deepEqual(inspectRaster(jpeg),{width:30,height:20,mime:'image/jpeg'});
  for(const b of [png(0,2),png(20000,2),png(10000,10000),new Uint8Array(100),new TextEncoder().encode(svg('<script/>')),new Uint8Array(10*1024*1024+1)])assert.throws(()=>inspectRaster(b));
});
test('SVG geometry lengths support absolute units, and composed tiny transforms fail',()=>{
  const r=parseSVG(svg('<rect width="25.4mm" height="1in"/>','width="96px" height="96px"'));
  near(r.bounds.width,25.4);near(r.bounds.height,25.4);
  assert.throws(()=>parseSVG(svg('<g transform="scale(.00001)"><line x2="1" transform="scale(.00001)"/></g>')),/small|singular/);
});
