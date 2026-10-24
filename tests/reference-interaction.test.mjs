import test from 'node:test';
import assert from 'node:assert/strict';
import { initWorkflow } from '../js/workflow.mjs';
import { createDoc, applyOps } from '../js/model.mjs';
import { referencePoint } from '../js/project.mjs';
import { setLanguage } from '../js/i18n.mjs';

// Bounded synthetic-image and DOM contract harness. No browser layout claims.
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const raster={width:8,height:8,data:new Uint8ClampedArray(8*8*4).fill(255)};
for(let y=2;y<6;y++)for(let x=2;x<6;x++)for(let c=0;c<3;c++)raster.data[(y*8+x)*4+c]=0;
class Element {
  constructor(){this.value='';this.checked=false;this.hidden=false;this.open=false;this.listeners={};this.children=[];this.dataset={};this.classList={toggle(){}};this.width=600;this.height=300;this.textContent='';}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  async fire(type,props={}){for(const fn of this.listeners[type]||[])await fn({type,preventDefault(){},...props});}
  appendChild(el){this.children.push(el);}
  append(...els){this.children.push(...els);}
  setAttribute(key,value){this[key]=value;}
  focus(){}
  close(){if(this.open){this.open=false;this.fire('close');}}
  getContext(){return new Proxy({measureText:text=>({width:text.length*6}),getImageData:()=>raster},{get:(o,k)=>o[k]||(()=>{})});}
}
function setup(overrides={}){
  setLanguage('en');const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const document={getElementById:el,querySelectorAll:()=>[],createElement:()=>new Element(),activeElement:null};
  const window={Image:class{naturalWidth=8;naturalHeight=8;set src(v){this._src=v;this.onload?.();}}};
  const doc=createDoc();doc.references=[{id:'image-1',name:'Synthetic',dataURL:PNG,center:[0,0],width:100,height:60,rotation:0,opacity:.55,locked:false,calibrated:true,...overrides}];doc.annotations=[];
  const view={s:2,ox:300,oy:200},canvas={clientWidth:600,clientHeight:400};
  const w2s=p=>[view.ox+p[0]*view.s,view.oy-p[1]*view.s],s2w=p=>[(p[0]-view.ox)/view.s,(view.oy-p[1])/view.s];
  const history=[],hints=[],sketches=[];let draws=0;
  const workflow=initWorkflow({document,window,doc,canvas,ctx:new Element().getContext(),view,w2s,s2w,pushUndo:()=>history.push(structuredClone(doc)),draw:()=>draws++,refreshTimeline(){},openDialog:d=>{d.open=true;},wireDialog(){},setTool(){},setHint:v=>hints.push(v),addMsg(){},openSketch:id=>sketches.push(id)});
  const event=(type='pointerdown',id=1)=>({type,pointerId:id,button:0,pointerType:'mouse'});
  return {workflow,doc,el,history,w2s,s2w,event,hints,sketches,view,undo(){Object.assign(doc,history.pop());workflow.refresh();}};
}
const near=(a,b)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-8,`${a} != ${b}`));

test('locked reference body is selectable and deletable without touching accepted geometry; undo restores annotations',()=>{
  const h=setup({locked:true});applyOps(h.doc,[{op:'line',p1:[0,0],p2:[10,10]}]);const geometry=structuredClone(h.doc.entities);
  h.doc.annotations.push({id:'note-1',referenceId:'image-1',type:'note',a:[.5,.5],offset:[14,-18],text:'Keep'});h.doc.selectedId=h.doc.entities[0].id;
  assert.equal(h.workflow.pointerDown(h.w2s([0,0]),h.event()),true);assert.equal(h.doc.selectedId,null);assert.equal(h.workflow.selectedReference().id,'image-1');
  h.workflow.pointerMove(h.w2s([20,30]),h.event('pointermove'));h.workflow.pointerEnd(h.event('pointerup'));assert.equal(h.history.length,0);near(h.doc.references[0].center,[0,0]);
  assert.equal(h.workflow.deleteSelectedReference(),true);assert.equal(h.doc.references.length,0);assert.equal(h.doc.annotations.length,0);assert.deepEqual(h.doc.entities,geometry);assert.equal(h.history.length,1);
  h.undo();assert.equal(h.doc.references.length,1);assert.equal(h.doc.annotations.length,1);assert.deepEqual(h.doc.entities,geometry);
});

test('tap and sub-threshold motion do not mutate or create history; drag commits exactly one undo',()=>{
  const h=setup(),start=h.w2s([0,0]),before=structuredClone(h.doc.references[0]);
  h.workflow.pointerDown(start,h.event());h.workflow.pointerMove([start[0]+3,start[1]],h.event('pointermove'));assert.deepEqual(h.doc.references[0],before);h.workflow.pointerEnd(h.event('pointerup'));assert.equal(h.history.length,0);
  h.workflow.pointerDown(start,h.event());h.workflow.pointerMove([start[0]+12,start[1]+8],h.event('pointermove'));h.workflow.pointerMove([start[0]+30,start[1]+20],h.event('pointermove'));assert.equal(h.history.length,0);near(h.doc.references[0].center,[15,-10]);h.workflow.pointerEnd(h.event('pointerup'));assert.equal(h.history.length,1);near(h.history[0].references[0].center,[0,0]);h.undo();assert.deepEqual(h.doc.references[0],before);
});

test('pointer cancellation, pinch cancellation and zero-net gesture restore baseline without history',()=>{
  for(const cancellation of ['pointercancel','lostpointercapture','pinch']){const h=setup(),start=h.w2s([0,0]);h.workflow.pointerDown(start,h.event());h.workflow.pointerMove([start[0]+30,start[1]+20],h.event('pointermove'));
    if(cancellation==='pinch')h.workflow.cancelGesture();else h.workflow.pointerEnd(h.event(cancellation));near(h.doc.references[0].center,[0,0]);assert.equal(h.history.length,0);
  }
  const h=setup(),start=h.w2s([0,0]);h.workflow.pointerDown(start,h.event());h.workflow.pointerMove([start[0]+30,start[1]],h.event('pointermove'));h.workflow.pointerMove(start,h.event('pointermove'));h.workflow.pointerEnd(h.event('pointerup'));assert.equal(h.history.length,0);
});

test('uniform rotated corner scale fixes opposite corner and is reversible; wrong pointer cannot commit',()=>{
  const h=setup({rotation:31}),r=h.doc.references[0];h.workflow.selectReference(r.id);const start=h.w2s(referencePoint(r,[1,0])),opposite=referencePoint(r,[0,1]),before=structuredClone(r);
  h.workflow.pointerDown(start,h.event());const finish=h.w2s(referencePoint({...r,width:r.width*2,height:r.height*2,center:before.center.map((v,i)=>opposite[i]+(v-opposite[i])*2)},[1,0]));
  assert.equal(h.workflow.pointerMove(finish,h.event('pointermove',2)),false);h.workflow.pointerMove(finish,h.event('pointermove'));near(referencePoint(r,[0,1]),opposite);assert.ok(Math.abs(r.width-200)<1e-8);assert.ok(Math.abs(r.width/r.height-before.width/before.height)<1e-8);assert.equal(r.calibrated,false);
  assert.equal(h.workflow.pointerEnd(h.event('pointerup',2)),false);assert.equal(h.history.length,0);h.workflow.pointerEnd(h.event('pointerup'));assert.equal(h.history.length,1);h.undo();assert.deepEqual(h.doc.references[0],before);
});

test('context lock blocks width edit while opacity and rebuild remain available',async()=>{
  const h=setup({locked:true});h.workflow.selectReference('image-1');h.el('reference-context-width').value='200';await h.el('reference-context-width').fire('change');assert.equal(h.doc.references[0].width,100);
  h.el('reference-context-opacity').value='.25';await h.el('reference-context-opacity').fire('change');assert.equal(h.doc.references[0].opacity,.25);await h.el('reference-context-sketch').fire('click');assert.deepEqual(h.sketches,['image-1']);
  await h.el('reference-context-lock').fire('click');assert.equal(h.doc.references[0].locked,false);h.el('reference-context-width').value='200';await h.el('reference-context-width').fire('change');assert.equal(h.doc.references[0].height,120);assert.equal(h.doc.references[0].calibrated,false);
});

test('unverified trace requires deliberate acknowledgement and acceptance rejects stale image scale',async()=>{
  const h=setup({calibrated:false});h.workflow.startTrace('image-1');h.workflow.drawUnderlay();h.el('trace-threshold').value='128';h.el('trace-area').value='0';h.el('trace-simplify').value='.1';h.el('trace-mode').value='global';
  await h.el('trace-preview').fire('click');assert.match(h.el('workshop-error').textContent,/Calibrate a known length/);assert.equal(h.doc.entities.length,0);
  h.el('trace-unverified').checked=true;await h.el('trace-preview').fire('click');assert.equal(h.el('import-preview').hidden,false);assert.match(h.el('preview-summary').textContent,/Unverified scale/);
  h.doc.references[0].width=110;await h.el('preview-accept').fire('click');assert.match(h.el('workshop-error').textContent,/fresh trace preview/);assert.equal(h.doc.entities.length,0);
  await h.el('trace-preview').fire('click');await h.el('preview-accept').fire('click');assert.ok(h.doc.entities.length>0);assert.equal(h.doc.selectedReferenceId,null);
});

test('trace known-length calibration resumes preview workflow and never rescales existing paths',async()=>{
  const h=setup({calibrated:false});applyOps(h.doc,[{op:'line',p1:[0,0],p2:[10,0]}]);const before=structuredClone(h.doc.entities);h.workflow.startTrace('image-1');await h.el('trace-calibrate').fire('click');assert.equal(h.workflow.picking(),true);
  assert.equal(h.workflow.clickPoint([1000,1000]),true);assert.equal(h.el('annotation-dialog').open,false);h.workflow.clickPoint([-25,0]);h.workflow.clickPoint([25,0]);h.el('annotation-value').value='100';await h.el('annotation-form').fire('submit');
  assert.equal(h.doc.references[0].width,200);assert.equal(h.doc.references[0].calibrated,true);assert.equal(h.el('workshop-dialog').open,true);assert.deepEqual(h.doc.entities,before);assert.equal(h.history.length,1);
});

test('attached annotation label uses threshold and cancel semantics independently of image lock',()=>{
  const h=setup({locked:true});h.doc.annotations.push({id:'note-1',referenceId:'image-1',type:'note',a:[.5,.5],offset:[14,-18],text:'Known point'});h.workflow.drawAnnotations();
  const start=[320,180];assert.equal(h.workflow.pointerDown(start,h.event()),true);h.workflow.pointerMove([321,182],h.event('pointermove'));near(h.doc.annotations[0].offset,[14,-18]);
  h.workflow.pointerMove([340,190],h.event('pointermove'));near(h.doc.annotations[0].offset,[34,-8]);h.workflow.pointerEnd(h.event('pointercancel'));near(h.doc.annotations[0].offset,[14,-18]);assert.equal(h.history.length,0);
  h.workflow.drawAnnotations();h.workflow.pointerDown(start,h.event());h.workflow.pointerMove([340,190],h.event('pointermove'));h.workflow.pointerEnd(h.event('pointerup'));assert.equal(h.history.length,1);near(h.doc.references[0].center,[0,0]);
});

test('scale cancellation restores calibration, and locked corner drag never rescales',()=>{
  for(const locked of [false,true]){const h=setup({locked});h.workflow.selectReference('image-1');const r=h.doc.references[0],before=structuredClone(r),start=h.w2s(referencePoint(r,[1,0]));h.workflow.pointerDown(start,h.event());h.workflow.pointerMove([start[0]+20,start[1]-12],h.event('pointermove'));if(locked)assert.deepEqual(r,before);h.workflow.pointerEnd(h.event('pointercancel'));assert.deepEqual(r,before);assert.equal(h.history.length,0);}
});
