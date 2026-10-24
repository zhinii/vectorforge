import test from 'node:test';
import assert from 'node:assert/strict';
import {reconstructSketch,validateSketchSpec,inferOrthogonalDirections,validateSketchRegistry,reconcileSketches} from '../js/sketch.mjs';
import {createDoc,applyOps} from '../js/model.mjs';
const base=(kind,dimensions)=>({version:1,kind,anchor:[0,0],rotation:0,dimensions});
const profile=lengths=>({...base('profile'),edges:['right','up','left','down'].map((direction,i)=>({direction,length:lengths[i]}))});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} ≠ ${b}`);
function built(spec){const r=reconstructSketch(spec,{group:'sketch-1'}),doc=createDoc();applyOps(doc,r.ops);doc.sketches={'sketch-1':r.spec};return {r,doc,e:doc.entities[0]};}
test('all supported reconstructions create real editable geometry driven by dimensions',()=>{
  const l=built({...base('line',{length:120}),anchor:[20,30],rotation:90});near(l.e.p2[0],20);near(l.e.p2[1],150);
  const c=built(base('circle',{radius:25}));assert.equal(c.e.r,25);
  const a=built({...base('arc',{radius:8,startAngle:20,sweep:210}),rotation:30});assert.equal(a.e.a0,50);assert.equal(a.e.a1,260);
  const rect=built({...base('rectangle',{width:100,height:40}),rotation:90});assert.equal(rect.e.type,'path');assert.equal(rect.e.closed,true);near(rect.e.points[2][0],-40);near(rect.e.points[2][1],100);
  assert.equal(built(profile([100,40,100,40])).e.points.length,4);
});
test('dimensions dominate inaccurate photo proportions; provenance survives regeneration',()=>{
  const spec={...base('rectangle',{width:120,height:35}),landmarks:[[0,0],[17,0],[20,99]],referenceId:'image-a',bindings:{width:'note-w',height:'note-h'}};
  const {r,e}=built(spec);assert.deepEqual(e.points[2],[120,35]);assert.deepEqual(r.spec.bindings,spec.bindings);r.spec.dimensions.width=200;assert.deepEqual(built(r.spec).e.points[2],[200,35]);assert.equal(spec.dimensions.width,120);
});
test('orthogonal landmark proposals infer pose and topology but never lengths',()=>{
  const proposed=inferOrthogonalDirections([[10,20],[10,120],[-30,119],[-32,20]]);near(proposed.rotation,90);assert.deepEqual(proposed.anchor,[10,20]);assert.deepEqual(proposed.edges.map(e=>e.direction),['right','up','left','down']);assert.ok(proposed.edges.every(e=>e.length===null));assert.throws(()=>reconstructSketch({...base('profile'),...proposed}),/sketch.underdetermined/);
});
test('L profile reconstruction validates all six explicit linked edges',()=>{
  const spec={...base('profile'),edges:[['right',100],['up',40],['left',60],['up',50],['left',40],['down',90]].map(([direction,length])=>({direction,length}))};
  assert.deepEqual(built(spec).e.points,[[0,0],[100,0],[100,40],[40,40],[40,90],[0,90]]);
  spec.edges[0].length=110;assert.throws(()=>reconstructSketch(spec),/sketch.closureConflict/);
});
test('missing, zero, conflicting or out of range dimensions never produce geometry',()=>{
  for(const value of [undefined,null,'',0,-1,Infinity,NaN,100001,{},true,'   '])assert.throws(()=>reconstructSketch(base('line',{length:value})));
  assert.throws(()=>reconstructSketch(profile([100,40,99,40])),/sketch.closureConflict/);
  assert.throws(()=>reconstructSketch(base('arc',{radius:10,startAngle:0,sweep:360})),/sketch.arcSweep/);
  assert.throws(()=>reconstructSketch({...base('circle',{radius:10}),anchor:[99999,0]}),/sketch.invalid/);
  assert.throws(()=>reconstructSketch({...base('profile'),edges:Array(34).fill({direction:'right',length:1})}),/sketch.vertexLimit/);
});
test('rejects self-intersecting and overlapping orthogonal profiles even with closed totals',()=>{
  const spec={...base('profile'),edges:[['right',40],['up',40],['left',20],['down',60],['left',20],['up',20]].map(([direction,length])=>({direction,length}))};
  assert.throws(()=>reconstructSketch(spec),/sketch.selfIntersection/);
  const collinear={...base('profile'),edges:[['right',10],['right',10],['up',10],['left',20],['down',10]].map(([direction,length])=>({direction,length}))};assert.throws(()=>reconstructSketch(collinear),/sketch.redundantCorner/);
});
test('strict registry accepts geometry with different IDs; direct edits detach stale recipes',()=>{
  const {doc}=built(base('rectangle',{width:120,height:35}));doc.entities[0].id='e1234';assert.equal(Object.keys(validateSketchRegistry(doc.sketches,doc.entities)).length,1);assert.equal(reconcileSketches(doc),0);
  doc.entities[0].points[1][0]++;assert.throws(()=>validateSketchRegistry(doc.sketches,doc.entities),/sketch.stale/);assert.equal(reconcileSketches(doc),1);assert.deepEqual(doc.sketches,{});
});
test('metadata validator rejects poisoned shapes and sanitizes bounded provenance',()=>{
  assert.throws(()=>validateSketchSpec({...base('circle',{radius:2}),bindings:{'bad.key':'note-x'}}));
  assert.throws(()=>validateSketchSpec({...base('circle',{radius:2}),referenceId:'<script>'}));
  assert.throws(()=>validateSketchRegistry([]));
  const {r}=built(base('circle',{radius:2}));assert.deepEqual(validateSketchRegistry({'sketch-gone':r.spec},[]),{});
});

import {initSketch} from '../js/sketch-ui.mjs';
import {readFileSync} from 'node:fs';
import {nextId} from '../js/model.mjs';
function uiHarness(){
  const nodes=new Map();const context=new Proxy({},{get:()=>()=>{}});
  class Element{
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.value='';this.checked=false;this.hidden=false;this.open=false;this.width=480;this.height=240;}
    set id(value){this._id=value;nodes.set(value,this);}get id(){return this._id;}
    set textContent(value){this._text=value;this.children=[];}get textContent(){return this._text||'';}
    append(...children){this.children.push(...children);}appendChild(child){this.append(child);}
    setAttribute(){}addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
    fire(name){for(const fn of this.listeners[name]||[])fn({target:this});}
    close(){if(this.open){this.open=false;this.fire('close');}}
    getContext(){return context;}
  }
  const document={getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag)};
  for(const [,id] of readFileSync(new URL('../docs/sketch-ui-fragment.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g)){const el=new Element(id.includes('canvas')?'canvas':'div');el.id=id;}
  const doc={...createDoc(),references:[],annotations:[],sketches:{}};let undos=0,clears=0;const ui=initSketch({document,doc,ctx:context,w2s:p=>p,pushUndo:()=>undos++,draw:()=>{},refreshTimeline:()=>{},openDialog:d=>{d.open=true;},setTool:()=>{},setHint:()=>{},t:x=>x,clearReferenceSelection:()=>{clears++;}});
  return {ui,doc,nodes,click:id=>nodes.get(id).fire('click'),undos:()=>undos,clears:()=>clears};
}
function readyLine(h,length=100){h.ui.open();h.nodes.get('sketch-value-length').value=String(length);h.click('sketch-pick');h.ui.clickPoint([0,0]);h.ui.clickPoint([17,2]);h.nodes.get('sketch-confirm').checked=true;h.click('sketch-preview');assert.equal(h.nodes.get('sketch-result').hidden,false);}
test('UI preserves typed pre-pick values, previews without mutation and rejects stale inputs without events',()=>{
  const h=uiHarness(),before=JSON.stringify(h.doc);readyLine(h);assert.equal(h.nodes.get('sketch-value-length').value,'100');assert.equal(JSON.stringify(h.doc),before);
  h.nodes.get('sketch-value-length').value='200';h.click('sketch-accept');assert.equal(h.undos(),0);assert.equal(h.doc.entities.length,0);assert.match(h.nodes.get('sketch-error').textContent,/sketch.previewStale/);
  h.click('sketch-preview');h.click('sketch-accept');assert.equal(h.doc.entities.length,1);assert.equal(h.undos(),1);assert.equal(h.clears(),1);assert.equal(Object.values(h.doc.sketches)[0].dimensions.length,200);
});
test('UI rejects stale note/reference/document snapshots and cancellation changes nothing',()=>{
  for(const mutate of [doc=>doc.references.push({id:'image-new'}),doc=>doc.annotations.push({id:'note-new'}),doc=>doc.entities.push({id:'foreign',type:'circle',c:[0,0],r:3}),doc=>doc.sketches.other={}]){
    const h=uiHarness();readyLine(h);mutate(h.doc);const changed=JSON.stringify(h.doc);h.click('sketch-accept');assert.equal(h.undos(),0);assert.equal(JSON.stringify(h.doc),changed);assert.match(h.nodes.get('sketch-error').textContent,/sketch.previewStale/);h.ui.cancel();assert.equal(JSON.stringify(h.doc),changed);
  }
});
test('overlay redraws do not allocate geometry IDs and linked edits preserve fabrication metadata',()=>{
  const h=uiHarness();readyLine(h);const before=Number(nextId().slice(1));for(let i=0;i<50;i++)h.ui.drawOverlay();assert.equal(Number(nextId().slice(1)),before+1);h.click('sketch-accept');
  Object.assign(h.doc.entities[0],{layer:'engrave',hole:true,name:'Important name'});assert.equal(h.ui.editSelected(),true);h.nodes.get('sketch-value-length').value='70';h.nodes.get('sketch-confirm').checked=true;h.click('sketch-preview');h.click('sketch-accept');assert.equal(h.doc.entities.length,1);assert.equal(h.doc.entities[0].layer,'engrave');assert.equal(h.doc.entities[0].hole,true);assert.equal(h.doc.entities[0].name,'Important name');assert.equal(Object.values(h.doc.sketches)[0].dimensions.length,70);
});
test('editing a stale group refuses without silently mutating retained metadata',()=>{
  const h=uiHarness();readyLine(h);h.click('sketch-accept');h.doc.entities[0].p2[0]++;const before=JSON.stringify(h.doc);assert.equal(h.ui.editSelected(),false);assert.equal(JSON.stringify(h.doc),before);
});
test('UI explicitly associates existing reference notes and keeps their values as driving metadata',()=>{
  const h=uiHarness();h.doc.references=[{id:'image-a'}];h.doc.annotations=[{id:'note-a',referenceId:'image-a',type:'dimension',value:160,text:'Measured base'}];h.ui.open('image-a');h.click('sketch-pick');h.ui.clickPoint([5,5]);h.ui.clickPoint([25,5]);
  const box=h.nodes.get('sketch-fields').children[0],choice=box.children.find(e=>e.tagName==='SELECT');assert.equal(choice.children.length,2);choice.value='note-a';choice.fire('change');h.nodes.get('sketch-confirm').checked=true;h.click('sketch-preview');h.click('sketch-accept');const spec=Object.values(h.doc.sketches)[0];assert.equal(spec.dimensions.length,160);assert.equal(spec.bindings.length,'note-a');near(h.doc.entities[0].p2[0],165);
});
test('UI shows uncertain direction warning, requires all profile dimensions, and checks closure',()=>{
  const h=uiHarness();h.ui.open();h.nodes.get('sketch-kind').value='profile';h.nodes.get('sketch-kind').fire('change');h.click('sketch-pick');for(const p of [[0,0],[100,0],[130,40],[0,40]])h.ui.clickPoint(p);h.click('sketch-pick-done');assert.match(h.nodes.get('sketch-status').textContent,/sketch.uncertainDirections/);h.nodes.get('sketch-confirm').checked=true;h.click('sketch-preview');assert.match(h.nodes.get('sketch-error').textContent,/sketch.underdetermined/);
  [100,40,90,40].forEach((v,i)=>{h.nodes.get('sketch-value-edge-'+i).value=String(v);});h.click('sketch-preview');assert.match(h.nodes.get('sketch-error').textContent,/sketch.closureConflict/);h.nodes.get('sketch-value-edge-2').value='100';h.click('sketch-preview');h.click('sketch-accept');assert.deepEqual(h.doc.entities[0].points,[[0,0],[100,0],[100,40],[0,40]]);
});
