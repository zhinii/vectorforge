import test from 'node:test';
import assert from 'node:assert/strict';
import { listTemplates, generateTemplate } from '../js/templates.mjs';
import { createDoc, applyOps } from '../js/model.mjs';
const near = (a, b, eps = 1e-7) => assert.ok(Math.abs(a-b)<eps, `${a} != ${b}`);
const bounds = points => ({ minX:Math.min(...points.map(p=>p[0])), maxX:Math.max(...points.map(p=>p[0])), minY:Math.min(...points.map(p=>p[1])), maxY:Math.max(...points.map(p=>p[1])) });
const signedArea = p => p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1];},0)/2;
function selfIntersects(p) {
  const cross = (a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<p.length;i++) for(let j=i+2;j<p.length;j++) {
    if(i===0 && j===p.length-1) continue;
    const a=p[i],b=p[(i+1)%p.length],c=p[j],d=p[(j+1)%p.length];
    if(cross(a,b,c)*cross(a,b,d)<-1e-9 && cross(c,d,a)*cross(c,d,b)<-1e-9) return true;
  }
  return false;
}

test('five bilingual templates expose bounded editable numeric parameters', () => {
  const all=listTemplates(); assert.equal(all.length,5);
  assert.deepEqual(all.map(t=>t.id),['tshirt','dress','house','keytag','apron']);
  for(const t of all) {
    assert.ok(t.title.en && t.title.zh && t.description.en && t.description.zh);
    for(const p of t.parameters) {
      assert.ok(p.label.en && p.label.zh); assert.ok(p.default>=p.min && p.default<=p.max); assert.ok(p.step>0);
    }
  }
  all[0].parameters[0].default=NaN;
  assert.equal(listTemplates()[0].parameters[0].default,520);
});

test('default templates create finite connected contours and valid model entities', () => {
  for(const template of listTemplates()) {
    const result=generateTemplate(template.id);
    const doc=createDoc(); applyOps(doc,result.ops);
    assert.equal(doc.entities.length,result.ops.length);
    assert.ok(result.name.en && result.name.zh);
    for(const message of [...result.warnings,...result.notes]) assert.ok(message.en && message.zh);
    for(const op of result.ops) {
      assert.ok(['cut','engrave','reference'].includes(op.layer));
      assert.ok(op.group && op.name);
      if(op.op==='text') assert.equal(op.layer,'reference');
      if(op.op==='path') {
        assert.ok(op.points.every(p=>p.length===2 && p.every(Number.isFinite)));
        if(op.layer==='cut') {
          assert.equal(op.closed,true);
          assert.ok(Math.abs(signedArea(op.points))>0);
          assert.equal(selfIntersects(op.points),false,op.name);
          for(let i=0;i<op.points.length;i++) assert.notDeepEqual(op.points[i],op.points[(i+1)%op.points.length]);
        }
      }
    }
  }
});

test('garment illustrations are honest flats, not sewing pattern claims', () => {
  for(const id of ['tshirt','dress']) {
    const result=generateTemplate(id);
    assert.match(result.warnings[0].en,/not a sewing pattern/);
    assert.equal(result.ops.filter(o=>o.layer==='cut').length,1);
  }
  const tee=generateTemplate('tshirt',{bodyWidth:600,sleeveLength:200,bodyLength:900});
  const b=bounds(tee.ops[0].points); near(b.maxX-b.minX,1000); near(b.maxY-b.minY,900);
  assert.equal(generateTemplate('dress',{hemWidth:1100}).dimensions.overallWidth,1100);
});

test('house separates engraving from the single cut boundary', () => {
  const result=generateTemplate('house',{width:200,height:140,roofHeight:90});
  assert.equal(result.ops.filter(o=>o.layer==='cut').length,1);
  assert.ok(result.ops.some(o=>o.layer==='engrave'));
  near(result.dimensions.overallHeight,230);
});

test('keytag contains a clockwise hole entirely inside the rounded boundary', () => {
  for(const params of [{},{width:30,height:100,holeDiameter:12},{width:200,height:15,holeDiameter:6}]) {
    const result=generateTemplate('keytag',params), [outer,hole]=result.ops;
    assert.equal(outer.hole,false); assert.equal(hole.hole,true); assert.equal(hole.closed,true);
    assert.ok(signedArea(outer.points)>0); assert.ok(signedArea(hole.points)<0);
    const b=bounds(outer.points),h=bounds(hole.points);
    assert.ok(h.minX>b.minX && h.maxX<b.maxX && h.minY>b.minY && h.maxY<b.maxY);
  }
});

test('apron uses exact edge-normal seam allowances, not proportional scaling', () => {
  for(const sa of [0,1,10,25]) {
    const result=generateTemplate('apron',{seamAllowance:sa});
    const cut=result.ops.find(o=>o.name.startsWith('Apron body cutline'));
    const seam=result.ops.find(o=>o.name==='Apron body finished seamline');
    assert.equal(cut.points.length,seam.points.length);
    for(let i=0;i<seam.points.length;i++) {
      const a=seam.points[i],b=seam.points[(i+1)%seam.points.length];
      const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
      for(const v of [cut.points[i],cut.points[(i+1)%cut.points.length]])
        near(((v[0]-a[0])*dy-(v[1]-a[1])*dx)/len,sa);
    }
    const b=bounds(cut.points); near(b.maxX-b.minX,650+2*sa); near(b.maxY-b.minY,800+2*sa);
  }
});

test('apron measurements drive body dimensions, bib, straps and waist ease independently', () => {
  const a=generateTemplate('apron'), b=generateTemplate('apron',{bodyWidth:700,bodyLength:950,bibWidth:300,bibHeight:300,waist:1000,ease:80,neckStrapLength:650,strapWidth:40,seamAllowance:15});
  assert.equal(a.dimensions.finishedTieLength,495);
  assert.equal(b.dimensions.finishedTieLength,540);
  assert.equal(b.dimensions.bodyCutWidth,730);
  assert.equal(b.dimensions.bodyCutHeight,980);
  assert.equal(b.dimensions.strapCutWidth,110);
  assert.equal(b.dimensions.neckCutLength,680);
  assert.equal(b.dimensions.tieCutLength,570);
  const ease=generateTemplate('apron',{ease:100});
  assert.equal(ease.dimensions.finishedBodyWidth,a.dimensions.finishedBodyWidth);
  assert.equal(ease.dimensions.finishedTieLength-a.dimensions.finishedTieLength,30);
  assert.match(b.notes[1].en,/Ease affects tie reach only/);
});

test('apron has non-overlapping pieces, cut quantities, mark-only notches and true 50 mm reference square', () => {
  const r=generateTemplate('apron'), cuts=r.ops.filter(o=>o.layer==='cut');
  assert.equal(cuts.length,4); // one body master (cut 2), neck master and two tie pieces
  assert.match(cuts[0].name,/CUT 2/);
  for(let i=0;i<cuts.length;i++) for(let j=i+1;j<cuts.length;j++) {
    const a=bounds(cuts[i].points),b=bounds(cuts[j].points);
    assert.ok(a.maxX<b.minX || b.maxX<a.minX || a.maxY<b.minY || b.maxY<a.minY);
  }
  assert.ok(r.ops.filter(o=>o.name.includes('Grainline')).length>=4);
  const notches=r.ops.filter(o=>o.name.includes('notch'));
  assert.equal(notches.length,8); assert.ok(notches.every(o=>o.layer==='reference'));
  const square=r.ops.find(o=>o.name.startsWith('50 mm calibration'));
  assert.equal(square.layer,'reference'); const s=bounds(square.points);
  near(s.maxX-s.minX,50); near(s.maxY-s.minY,50);
  assert.match(r.warnings[0].en,/DRAFT, UNTESTED FIT/);
  assert.match(r.notes[2].en,/outer and lining/);
  assert.match(generateTemplate('apron',{seamAllowance:0}).warnings.map(x=>x.en).join(' '),/allowance is zero/);
});

test('bounded corner cases remain finite and simple or reject invalid proportion combinations', () => {
  for(const t of listTemplates()) for(const p of t.parameters) for(const value of [p.min,p.max]) {
    try {
      const r=generateTemplate(t.id,{[p.key]:value});
      for(const op of r.ops.filter(o=>o.op==='path')) {
        assert.ok(op.points.every(p=>p.every(Number.isFinite)));
        if(op.closed) assert.equal(selfIntersects(op.points),false,`${t.id}: ${p.key}=${value}`);
      }
    } catch(e) {
      assert.match(e.message,/must be smaller|must exceed|must be at least|must leave|must not exceed|must allow/);
    }
  }
});

test('invalid and unknown parameters fail explicitly instead of silently falling back', () => {
  assert.throws(()=>generateTemplate('unknown'),/Unknown template/);
  for(const bad of [null,[],true,'bad']) assert.throws(()=>generateTemplate('apron',bad));
  for(const bad of [null,true,NaN,Infinity,-Infinity,{},[], '', ' ', '12mm', -10,1e12]) assert.throws(()=>generateTemplate('apron',{bodyWidth:bad}));
  assert.throws(()=>generateTemplate('apron',{waistline:1000}),/Unknown apron parameter/);
  assert.throws(()=>generateTemplate('apron',{bodyWidth:350,bibWidth:500}),/bibWidth/);
  assert.throws(()=>generateTemplate('apron',{bodyLength:450,bibHeight:450}),/bibHeight/);
  assert.throws(()=>generateTemplate('apron',{bibWidth:140,strapWidth:60}),/bibWidth/);
  assert.throws(()=>generateTemplate('dress',{waistWidth:700}),/waistWidth/);
  assert.throws(()=>generateTemplate('keytag',{height:15,holeDiameter:12}),/holeDiameter/);
  assert.equal(generateTemplate('apron',{bodyWidth:'700'}).dimensions.bodyWidth,700);
  const original=JSON.stringify(generateTemplate('apron'));
  generateTemplate('apron').ops[0].points[0][0]=999;
  assert.equal(JSON.stringify(generateTemplate('apron')),original);
});
