import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initGuidedTrace,MAX_GUIDED_ANCHORS,MAX_GUIDED_POINTS} from '../js/guided-trace-ui.mjs';
import {createDoc,applyOps} from '../js/model.mjs';
import {referencePoint} from '../js/project.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function pixels(size=96,flat=false){const data=new Uint8ClampedArray(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const inside=x>=20&&x<=size-21&&y>=20&&y<=size-21;const hole=x>size*.4&&x<size*.6&&y>size*.4&&y<size*.6;const v=!flat&&inside&&!hole?0:255;data.set([v,v,v,255],(y*size+x)*4);}return {width:size,height:size,data};}
function harness(options={}){
  const nodes=new Map();class Node{constructor(){this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.textContent='';this.events={};}addEventListener(type,fn){(this.events[type]||=[]).push(fn);}fire(type){for(const fn of this.events[type]||[])fn();}}
  for(const [,id]of readFileSync(new URL('../index.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g))nodes.set(id,new Node());
  const ref={id:'photo-1',name:'Test photo',center:[10,20],width:100,height:100,rotation:options.rotation||0,opacity:.5,locked:true,calibrated:!!options.calibrated,dataURL:'data:image/png;base64,photo'};
  const doc={...createDoc(),references:[ref],annotations:[],sketches:{},selectedReferenceId:ref.id};let undos=0,clears=0,draws=0,undoSnapshot;
  const ctx=new Proxy({},{get:()=>()=>{}});
  const ui=initGuidedTrace({document:{getElementById:id=>nodes.get(id)},doc,ctx,w2s:p=>p,getRaster:options.getRaster||(()=>Promise.resolve(pixels(options.size||96,options.flat))),draw:()=>draws++,setTool:()=>{},refreshTimeline:()=>{},pushUndo:()=>{undos++;undoSnapshot=structuredClone(doc);},clearReferenceSelection:()=>clears++,t:x=>x});
  return {ui,doc,nodes,ref,undos:()=>undos,clears:()=>clears,draws:()=>draws,undoSnapshot:()=>undoSnapshot,world:uv=>referencePoint(ref,uv)};
}
async function tap(h,uv){assert.equal(h.ui.clickPoint(h.world(uv)),true);await tick();}
async function line(h){assert.equal(await h.ui.start(h.ref.id),true);await tap(h,[20/95,20/95]);await tap(h,[75/95,20/95]);assert.equal(h.ui.state().anchorCount,2);}
function unscaled(h){h.nodes.get('guided-trace-unverified').checked=true;assert.equal(h.ui.keepScale(),true);}
test('starts immediately without shape/dimension forms, uses pixel edges and accepts one editable open engrave path',async()=>{
  const h=harness();const original=JSON.stringify(h.doc);await line(h);assert.equal(h.ui.state().phase,'trace');assert.equal(JSON.stringify(h.doc),original);assert.ok(h.ui.state().pointCount<=MAX_GUIDED_POINTS);
  assert.equal(await h.ui.finish(),true);assert.equal(h.nodes.get('guided-trace-accept').textContent,'guided.acceptUnscaled');assert.equal(h.nodes.get('guided-trace-accept').disabled,false);assert.equal(h.undos(),0);assert.equal(h.ui.accept(),true);
  assert.equal(h.doc.entities.length,1);const e=h.doc.entities[0];assert.equal(e.type,'path');assert.equal(e.closed,false);assert.equal(e.layer,'engrave');assert.equal(h.doc.selectedId,e.id);assert.equal(h.doc.selectedReferenceId,null);assert.equal(h.undos(),1);assert.equal(h.clears(),1);assert.equal(JSON.stringify(h.undoSnapshot()),original);assert.equal(h.ui.accept(),false);assert.equal(h.undos(),1);
});
test('rotated photo coordinates project faithfully to the final path',async()=>{
  const h=harness({rotation:67,calibrated:true});await line(h);await h.ui.finish();assert.equal(h.ui.keepScale(),true);assert.equal(h.ui.accept(),true);const pts=h.doc.entities[0].points;
  const a=h.world([20/95,20/95]),b=h.world([75/95,20/95]);pts[0].forEach((v,i)=>near(v,a[i]));pts.at(-1).forEach((v,i)=>near(v,b[i]));
});
test('known measurement stages uniform photo+trace scaling; existing vectors and UV notes do not move',async()=>{
  const h=harness({rotation:38});applyOps(h.doc,[{op:'line',from:[-100,0],to:[-40,0]}]);const vector=structuredClone(h.doc.entities[0]);h.doc.annotations=[{id:'note',referenceId:h.ref.id,type:'dimension',a:[.2,.5],b:[.8,.5],offset:[0,0],value:120,text:''}];const before=structuredClone(h.doc);
  await line(h);await h.ui.finish();assert.equal(h.ui.beginMeasurement(),true);await tap(h,[.2,.5]);await tap(h,[.8,.5]);h.nodes.get('guided-trace-length').value='120';h.nodes.get('guided-trace-length').fire('input');assert.equal(h.ui.state().scaleReady,true);assert.equal(h.nodes.get('guided-trace-accept').textContent,'guided.accept');assert.deepEqual(h.doc,before);assert.equal(h.ui.accept(),true);
  near(h.doc.references[0].width,200);near(h.doc.references[0].height,200);assert.deepEqual(h.doc.references[0].center,h.ref.center);assert.equal(h.doc.references[0].calibrated,true);assert.deepEqual(h.doc.entities[0],vector);assert.deepEqual(h.doc.annotations,before.annotations);const expected=referencePoint(h.doc.references[0],[20/95,20/95]);h.doc.entities[1].points[0].forEach((v,i)=>near(v,expected[i]));assert.equal(h.undos(),1);
});
test('closed outline traces its final edge and creates exactly one cut path, not inferred holes',async()=>{
  const h=harness();await line(h);await tap(h,[75/95,75/95]);await tap(h,[20/95,75/95]);assert.equal(await h.ui.finish(true),true);assert.equal(h.ui.state().closed,true);unscaled(h);assert.equal(h.ui.accept(),true);assert.equal(h.doc.entities.length,1);assert.equal(h.doc.entities[0].closed,true);assert.equal(h.doc.entities[0].hole,false);assert.equal(h.doc.entities[0].layer,'cut');assert.notDeepEqual(h.doc.entities[0].points[0],h.doc.entities[0].points.at(-1));
});
test('flat low-contrast pixels never append a guessed segment or enable finishing',async()=>{
  const h=harness({flat:true});await h.ui.start(h.ref.id);await tap(h,[.2,.2]);await tap(h,[.8,.2]);assert.equal(h.ui.state().anchorCount,1);assert.equal(h.ui.state().pointCount,1);assert.match(h.nodes.get('guided-trace-error').textContent,/guided.uncertain/);assert.equal(await h.ui.finish(),false);assert.equal(h.doc.entities.length,0);
});
test('undo restores previous anchor, and editing a finished closed trace removes only closing segment',async()=>{
  const h=harness();await line(h);await tap(h,[75/95,75/95]);assert.equal(h.ui.undoPoint(),true);assert.equal(h.ui.state().anchorCount,2);await tap(h,[75/95,75/95]);await tap(h,[20/95,75/95]);await h.ui.finish(true);assert.equal(h.ui.editTrace(),true);assert.equal(h.ui.state().closed,false);assert.equal(h.ui.state().anchorCount,4);assert.equal(h.ui.undoPoint(),true);assert.equal(h.ui.state().anchorCount,3);h.ui.cancel();assert.equal(h.ui.active(),false);assert.equal(h.doc.entities.length,0);assert.equal(h.undos(),0);
});
test('cancel during pending raster preparation cannot reopen or change document',async()=>{
  let resolve;const h=harness({getRaster:()=>new Promise(r=>resolve=r)});const original=JSON.stringify(h.doc);const pending=h.ui.start(h.ref.id);assert.equal(h.ui.active(),true);h.ui.cancel();resolve(pixels());assert.equal(await pending,false);assert.equal(h.ui.active(),false);assert.equal(JSON.stringify(h.doc),original);assert.equal(h.undos(),0);
});
test('new sessions invalidate old raster results even for the same photo',async()=>{
  const waits=[];const h=harness({getRaster:()=>new Promise(r=>waits.push(r))});const first=h.ui.start(h.ref.id),second=h.ui.start(h.ref.id);waits[1](pixels());assert.equal(await second,true);waits[0](pixels());assert.equal(await first,false);assert.equal(h.ui.state().phase,'trace');h.ui.cancel();
});
test('source, image transform, annotations and document changes invalidate staged acceptance',async()=>{
  for(const mutate of [h=>h.doc.references[0].width++,h=>h.doc.references[0].dataURL+='changed',h=>h.doc.references[0].rotation++,h=>h.doc.annotations.push({id:'changed'}),h=>h.doc.entities.push({id:'foreign',type:'circle',c:[0,0],r:1})]){
    const h=harness();await line(h);await h.ui.finish();unscaled(h);mutate(h);const changed=JSON.stringify(h.doc);assert.equal(h.ui.accept(),false);assert.equal(h.undos(),0);assert.equal(JSON.stringify(h.doc),changed);assert.equal(h.ui.active(),false);
  }
});
test('rapid hover movement shows only latest bounded candidate and never commits anchors',async()=>{
  const h=harness();await h.ui.start(h.ref.id);await tap(h,[20/95,20/95]);for(const x of [.3,.4,.5,.6,.7])h.ui.movePoint(h.world([x,20/95]));await new Promise(r=>setTimeout(r,90));assert.equal(h.ui.state().anchorCount,1);const hover=h.ui.state().hover;assert.ok(hover);near(hover.points.at(-1)[0],.7);assert.ok(hover.points.length<=MAX_GUIDED_POINTS);h.ui.movePoint(h.world([.75,20/95]));h.ui.cancel();await new Promise(r=>setTimeout(r,90));assert.equal(h.ui.state(),null);assert.equal(h.doc.entities.length,0);
});
test('changed measurement values or withdrawn unverified acknowledgement invalidate acceptance',async()=>{
  const h=harness();await line(h);await h.ui.finish();unscaled(h);h.nodes.get('guided-trace-unverified').checked=false;assert.equal(h.ui.accept(),false);assert.equal(h.undos(),0);
  h.ui.beginMeasurement();await tap(h,[.2,.5]);await tap(h,[.8,.5]);for(const invalid of ['','0','-1','Infinity','100001']){h.nodes.get('guided-trace-length').value=invalid;assert.equal(h.ui.stageMeasurement(),false);}h.nodes.get('guided-trace-length').value='120';assert.equal(h.ui.stageMeasurement(),true);h.nodes.get('guided-trace-length').value='121';assert.equal(h.ui.accept(),false);assert.equal(h.undos(),0);h.ui.cancel();
});
test('anchor budget is enforced and outside-image clicks never add points',async()=>{
  const h=harness({size:256});await h.ui.start(h.ref.id);assert.equal(h.ui.clickPoint(h.world([-1,0])),true);assert.equal(h.ui.state().anchorCount,0);
  for(let i=0;i<MAX_GUIDED_ANCHORS;i++)await tap(h,[(30+i*(225-30)/(MAX_GUIDED_ANCHORS-1))/255,20/255]);assert.equal(h.ui.state().anchorCount,MAX_GUIDED_ANCHORS);await tap(h,[235/255,30/255]);assert.equal(h.ui.state().anchorCount,MAX_GUIDED_ANCHORS);assert.match(h.nodes.get('guided-trace-error').textContent,/guided.anchorLimit/);assert.ok(h.ui.state().pointCount<=MAX_GUIDED_POINTS);h.ui.cancel();
});
test('cancel immediately after a tap invalidates pending segment and creates no undo entry',async()=>{
  const h=harness();await h.ui.start(h.ref.id);await tap(h,[20/95,20/95]);h.ui.clickPoint(h.world([75/95,20/95]));h.ui.cancel();await tick();assert.equal(h.ui.active(),false);assert.equal(h.undos(),0);assert.equal(h.doc.entities.length,0);
});
test('raster failure stays visible with a Cancel control instead of disappearing with the toolbar',async()=>{
  const h=harness({getRaster:async()=>{throw Error('unreadable');}});assert.equal(await h.ui.start(h.ref.id),false);assert.equal(h.nodes.get('guided-trace-toolbar').hidden,false);assert.equal(h.nodes.get('guided-trace-error').hidden,false);assert.match(h.nodes.get('guided-trace-error').textContent,/guided.rasterError/);h.nodes.get('guided-trace-cancel').fire('click');assert.equal(h.nodes.get('guided-trace-toolbar').hidden,true);
});
test('measurement input stays out of the way until both measurement endpoints are chosen',async()=>{
  const h=harness();await line(h);await h.ui.finish();assert.equal(h.nodes.get('guided-trace-measurement-fields').hidden,true);h.ui.beginMeasurement();await tap(h,[.2,.5]);assert.equal(h.nodes.get('guided-trace-measurement-fields').hidden,true);await tap(h,[.8,.5]);assert.equal(h.nodes.get('guided-trace-measurement-fields').hidden,false);h.ui.cancel();
});
test('animation frames and hover do not serialize full geometry or image data',async()=>{
  let serializations=0;const h=harness();h.doc.entities.push({id:'foreign',type:'circle',c:[0,0],r:1,toJSON(){serializations++;return {id:this.id,type:this.type,c:this.c,r:this.r};}});h.doc.references[0].dataURL+='a'.repeat(4*1024*1024);await h.ui.start(h.ref.id);await tap(h,[20/95,20/95]);const before=serializations;
  for(let i=0;i<100;i++){h.ui.drawOverlay();h.ui.movePoint(h.world([.5,20/95]));}await new Promise(r=>setTimeout(r,90));assert.equal(serializations,before);h.ui.cancel();
});
test('finished calibrated path accepts directly; legacy multi-step calibration controls stay hidden',async()=>{
  const h=harness({calibrated:true});await line(h);await h.ui.finish();assert.equal(h.nodes.get('guided-trace-accept').textContent,'guided.accept');assert.equal(h.nodes.get('guided-trace-accept').disabled,false);assert.equal(h.ui.accept(),true);
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');for(const id of ['guided-trace-keep-scale','guided-trace-apply-scale'])assert.match(html,new RegExp('id="'+id+'"[^>]*hidden'));assert.match(html,/<label hidden><input id="guided-trace-unverified"/);
});
test('Undo in review or measurement returns to editing without removing anchors or touching photo',async()=>{
  const h=harness();await line(h);const before=JSON.stringify(h.doc);await h.ui.finish();h.ui.undoPoint();assert.equal(h.ui.state().phase,'trace');assert.equal(h.ui.state().anchorCount,2);await h.ui.finish();h.ui.beginMeasurement();await tap(h,[.2,.5]);h.ui.undoPoint();assert.equal(h.ui.state().phase,'trace');assert.equal(h.ui.state().anchorCount,2);assert.equal(JSON.stringify(h.doc),before);assert.equal(h.undos(),0);h.ui.undoPoint();assert.equal(h.ui.state().anchorCount,1);h.ui.cancel();
});
test('invalid automatic measurement never falls back silently to unscaled acceptance',async()=>{
  const h=harness();await line(h);await h.ui.finish();h.ui.beginMeasurement();await tap(h,[.2,.5]);await tap(h,[.8,.5]);h.nodes.get('guided-trace-length').value='120';h.nodes.get('guided-trace-length').fire('input');assert.equal(h.ui.state().scaleReady,true);h.nodes.get('guided-trace-length').value='-2';h.nodes.get('guided-trace-length').fire('input');assert.equal(h.ui.state().scaleReady,false);assert.equal(h.nodes.get('guided-trace-accept').disabled,true);assert.equal(h.ui.accept(),false);assert.equal(h.undos(),0);assert.equal(h.doc.entities.length,0);h.ui.cancel();
});

test('uncertain pixels offer an explicit approximate line without mutation until two acceptances',async()=>{
 const h=harness({flat:true,rotation:37});const before=JSON.stringify(h.doc);await h.ui.start(h.ref.id);await tap(h,[.2,.2]);await tap(h,[.8,.4]);assert.equal(h.ui.state().suggestion,true);assert.equal(h.nodes.get('guided-trace-suggest').hidden,false);assert.equal(h.ui.state().anchorCount,1);assert.equal(JSON.stringify(h.doc),before);assert.equal(h.ui.useSuggestion(),true);assert.equal(h.ui.useSuggestion(),false);assert.equal(h.ui.state().approximateCount,1);assert.equal(h.ui.state().anchorCount,2);assert.equal(JSON.stringify(h.doc),before);await h.ui.finish();assert.equal(h.ui.accept(),true);assert.equal(h.undos(),1);const e=h.doc.entities[0];assert.deepEqual(e.points,[h.world([.2,.2]),h.world([.8,.4])]);assert.equal(e.closed,false);assert.equal(e.layer,'engrave');assert.match(e.name,/approximateName/);
});
test('approximate closed contour keeps all tap corners and closure and supports review editing',async()=>{
 const h=harness({flat:true});await h.ui.start(h.ref.id);await tap(h,[.2,.2]);for(const p of [[.8,.2],[.8,.8],[.2,.8]]){await tap(h,p);h.ui.useSuggestion();}assert.equal(await h.ui.finish(true),false);assert.equal(h.ui.state().suggestion,true);assert.equal(h.ui.useSuggestion(),true);assert.equal(h.ui.state().closed,true);h.ui.editTrace();assert.equal(h.ui.state().approximateCount,3);assert.equal(h.ui.state().anchorCount,4);await h.ui.finish(true);h.ui.useSuggestion();assert.equal(h.ui.accept(),true);const e=h.doc.entities[0];assert.equal(e.layer,'cut');assert.equal(e.closed,true);assert.equal(e.points.length,4);assert.deepEqual(e.points,[[.2,.2],[.8,.2],[.8,.8],[.2,.8]].map(h.world));
});
test('Undo discards pending suggestion first, then accepted approximate segment, never photo',async()=>{
 const h=harness({flat:true});await h.ui.start(h.ref.id);await tap(h,[.2,.2]);await tap(h,[.8,.2]);h.ui.undoPoint();assert.equal(h.ui.state().anchorCount,1);assert.equal(h.ui.state().suggestion,false);await tap(h,[.8,.2]);h.ui.useSuggestion();h.ui.undoPoint();assert.equal(h.ui.state().anchorCount,1);assert.equal(h.ui.state().approximateCount,0);assert.equal(h.doc.references.length,1);assert.equal(h.undos(),0);h.ui.cancel();assert.equal(h.ui.useSuggestion(),false);
});
test('new tap replaces weak-edge suggestion; changed source invalidates suggested acceptance',async()=>{
 const h=harness({flat:true});await h.ui.start(h.ref.id);await tap(h,[.2,.2]);await tap(h,[.8,.2]);await tap(h,[.7,.4]);h.ui.useSuggestion();await h.ui.finish();h.ui.accept();assert.deepEqual(h.doc.entities[0].points.at(-1),h.world([.7,.4]));
 const other=harness({flat:true});await other.ui.start(other.ref.id);await tap(other,[.2,.2]);await tap(other,[.8,.2]);other.ref.rotation=40;assert.equal(other.ui.useSuggestion(),false);assert.equal(other.undos(),0);assert.equal(other.doc.entities.length,0);
});
test('known length scales an approximate segment exactly and still creates one Undo step',async()=>{
 const h=harness({flat:true,rotation:25});await h.ui.start(h.ref.id);await tap(h,[.2,.2]);await tap(h,[.8,.2]);h.ui.useSuggestion();await h.ui.finish();h.ui.beginMeasurement();await tap(h,[.2,.2]);await tap(h,[.8,.2]);h.nodes.get('guided-trace-length').value='120';h.nodes.get('guided-trace-length').fire('input');assert.equal(h.ui.accept(),true);const p=h.doc.entities[0].points;near(Math.hypot(p[1][0]-p[0][0],p[1][1]-p[0][1]),120);assert.equal(h.undos(),1);
});
