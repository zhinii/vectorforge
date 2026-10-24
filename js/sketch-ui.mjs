import {reconstructSketch,inferOrthogonalDirections,validateSketchRegistry,MAX_SKETCH_VERTICES} from './sketch.mjs?v=20261024-13';
import {createDoc,applyOps,entityPoints,isClosed} from './model.mjs?v=20261024-13';
import {t as defaultT} from './i18n.mjs?v=20261024-13';
export function initSketch(h){
  const {document,doc,ctx,w2s,pushUndo,draw,refreshTimeline,openDialog,setTool,setHint}=h,t=h.t||defaultT;
  const $=id=>document.getElementById(id),dialog=$('sketch-dialog');doc.sketches ||= {};h.wireDialog?.(dialog,[]);
  let draft=null,preview=null,previewEntities=[],picking=false,points=[],editing=null,selectionBefore=null,topologyWarning=false,previewBaseline=null;
  const fields=new Map();
  const guide={line:'Pick the start and end direction of the line. Enter the real length.',circle:'Pick the center and a point on the circle. Enter the real radius.',arc:'Pick the center, arc start and arc end. Enter the real radius and counterclockwise sweep.',rectangle:'Pick a base corner, the next base corner, then a point on the height side. Enter width and height.',profile:'Pick each corner in order, without repeating the first. Finish landmarks to close. Assign every edge direction and length; opposite totals must close.'};
  const names={length:'Length',radius:'Radius',startAngle:'Start angle (degrees)',sweep:'Counterclockwise sweep (degrees)',width:'Width',height:'Height'};
  const text=(id,key)=>{$(id).textContent=t(key);};
  function clearError(){$('sketch-error').hidden=true;}
  function error(e){$('sketch-error').hidden=false;$('sketch-error').textContent=t(e.code||e.message)+(e.field?' · '+t(names[e.field]||e.field):'');}
  const on=(id,fn)=>$(id).addEventListener('click',()=>{clearError();try{fn();}catch(e){error(e);}});
  function invalidate(){preview=null;previewEntities=[];previewBaseline=null;$('sketch-result').hidden=true;draw();}
  function status(){text('sketch-status',draft?.anchor?'sketch.needsDimensions':'sketch.needsLandmarks');if(topologyWarning)$('sketch-status').textContent+=' '+t('sketch.uncertainDirections');}
  function show(){openDialog(dialog,$('sketch-pick'));render();}
  function render(){
    $('sketch-kind').value=draft.kind;text('sketch-guide',guide[draft.kind]);fields.clear();$('sketch-fields').textContent='';
    $('sketch-pose').textContent=draft.anchor?t('Inferred placement; confirm before preview.')+' '+draft.anchor.map(x=>x.toFixed(2)).join(', ')+' mm · '+draft.rotation.toFixed(1)+'°':'';
    if(draft.kind==='profile'){for(const [i,edge] of (draft.edges||[]).entries())addField('edge.'+i,t('Edge')+' '+(i+1),edge.length,edge);}
    else for(const key of {line:['length'],circle:['radius'],arc:['radius','startAngle','sweep'],rectangle:['width','height']}[draft.kind])addField(key,t(names[key]),draft.dimensions?.[key]);
    status();
  }
  function addField(key,label,value,edge){
    const box=document.createElement('div'),lab=document.createElement('label'),span=document.createElement('span'),input=document.createElement('input');
    span.textContent=label+(['startAngle','sweep'].includes(key)?'':' (mm)');input.type='number';input.step='any';input.min=key==='startAngle'?'-360':'0.000001';input.max=['startAngle','sweep'].includes(key)?'360':'100000';input.value=value??'';input.id='sketch-value-'+key.replace('.','-');lab.append(span,input);box.append(lab);
    if(edge){const direction=document.createElement('select');direction.setAttribute('aria-label',label+' '+t('Direction'));for(const d of ['right','up','left','down']){const o=document.createElement('option');o.value=d;o.textContent=t('direction.'+d);direction.append(o);}direction.value=edge.direction;direction.addEventListener('change',()=>{edge.direction=direction.value;$('sketch-confirm').checked=false;invalidate();});box.append(direction);}
    if(!['startAngle','sweep'].includes(key)){
      const notes=document.createElement('select');notes.setAttribute('aria-label',label+' '+t('Dimension note'));const empty=document.createElement('option');empty.value='';empty.textContent=t('Type value or choose a dimension note');notes.append(empty);
      for(const a of doc.annotations||[]){if(a.type!=='dimension'||a.referenceId!==draft.referenceId)continue;const o=document.createElement('option');o.value=a.id;o.textContent=(a.text?a.text+' · ':'')+a.value+' mm';notes.append(o);}
      notes.value=draft.bindings?.[key]||'';notes.addEventListener('change',()=>{const a=doc.annotations.find(a=>a.id===notes.value&&a.type==='dimension'&&a.referenceId===draft.referenceId);draft.bindings ||= {};if(a){input.value=a.value;draft.bindings[key]=a.id;}else delete draft.bindings[key];invalidate();});
      input.addEventListener('input',()=>{notes.value='';if(draft.bindings)delete draft.bindings[key];});box.append(notes);
    }
    input.addEventListener('input',invalidate);fields.set(key,input);$('sketch-fields').append(box);
  }
  function readInputs(){
    const next=structuredClone(draft);if(next.kind==='profile')(next.edges||[]).forEach((e,i)=>{e.length=fields.get('edge.'+i).value;});else{next.dimensions={};for(const [key,input] of fields)next.dimensions[key]=input.value;}
    return next;
  }
  function read(){if(!draft.anchor)throw Error('sketch.needsLandmarks');return readInputs();}
  function startPick(){
    // Preserve numeric input while replacing landmarks for the same shape.
    draft=readInputs();points=[];picking=true;invalidate();$('sketch-confirm').checked=false;dialog.close();setTool?.('select');$('sketch-pick-toolbar').hidden=false;setHint?.(t(guide[draft.kind]));pickStatus();draw();
  }
  function pickStatus(){const n={line:2,circle:2,arc:3,rectangle:3}[draft.kind];$('sketch-pick-status').textContent=t('Landmarks')+': '+points.length+(n?' / '+n:' / '+MAX_SKETCH_VERTICES);$('sketch-pick-done').disabled=points.length<(n||4);}
  function finishPick(){
    const needed={line:2,circle:2,arc:3,rectangle:3}[draft.kind]||4;if(points.length<needed)throw Error('sketch.needsLandmarks');
    if(draft.kind==='profile'){
      const result=inferOrthogonalDirections(points);draft.anchor=result.anchor;draft.rotation=result.rotation;draft.edges=result.edges;draft.bindings={};topologyWarning=!!result.warnings.length;
    }else{
      const [a,b]=points,dx=b[0]-a[0],dy=b[1]-a[1];if(Math.hypot(dx,dy)<1e-7)throw Error('sketch.invalid');draft.anchor=a.slice();draft.rotation=Math.atan2(dy,dx)*180/Math.PI;
      if(draft.kind==='rectangle'){const third=points[2];if(Math.abs(dx*(third[1]-a[1])-dy*(third[0]-a[0]))<1e-7)throw Error('sketch.invalid');if(dx*(third[1]-a[1])-dy*(third[0]-a[0])<0){draft.anchor=b.slice();draft.rotation+=180;}}
      draft.dimensions ||= {};if(draft.kind==='arc'&&draft.dimensions.startAngle===undefined)draft.dimensions.startAngle=0;
    }
    draft.landmarks=structuredClone(points);picking=false;$('sketch-pick-toolbar').hidden=true;setHint?.('');show();draw();
  }
  function clickPoint(world){if(!picking)return false;try{if(points.length>=MAX_SKETCH_VERTICES)throw Error('sketch.vertexLimit');if(!Array.isArray(world)||world.some(v=>!Number.isFinite(v)||Math.abs(v)>100000))throw Error('sketch.invalid');points.push(world.slice());pickStatus();draw();const n={line:2,circle:2,arc:3,rectangle:3}[draft.kind];if(n&&points.length===n)finishPick();}catch(e){picking=false;$('sketch-pick-toolbar').hidden=true;setHint?.('');show();error(e);}return true;}
  function open(referenceId){cancel();topologyWarning=false;selectionBefore=doc.selectedId;editing=null;draft={version:1,kind:'line',dimensions:{},bindings:{}};const ref=(doc.references||[]).find(r=>r.id===referenceId)||(doc.references||[])[0];if(ref)draft.referenceId=ref.id;$('sketch-confirm').checked=false;show();}
  function editSelected(){
    const selected=doc.entities.find(e=>e.id===doc.selectedId);let spec=selected?.group&&doc.sketches[selected.group];if(spec){try{validateSketchRegistry({[selected.group]:spec},doc.entities);}catch{spec=null;}}if(!spec){setHint?.(t('sketch.noLinkedDimensions'));return false;}
    cancel();topologyWarning=false;selectionBefore=doc.selectedId;editing=selected.group;draft=structuredClone(spec);$('sketch-confirm').checked=false;show();return true;
  }
  function cancel(){picking=false;points=[];invalidate();$('sketch-pick-toolbar').hidden=true;setHint?.('');if(dialog.open)dialog.close();}
  const baseline=()=>JSON.stringify({entities:doc.entities,references:doc.references||[],annotations:doc.annotations||[],sketches:doc.sketches||{}});
  function previewGeometry(){
    if(!$('sketch-confirm').checked)throw Error('sketch.confirmRequired');const result=reconstructSketch(read(),{group:editing||'sketch-preview'});preview=result;const stage=createDoc();applyOps(stage,result.ops);previewEntities=stage.entities;previewBaseline=baseline();renderPreview(result);$('sketch-result').hidden=false;text('sketch-status','sketch.confirmed');if(result.warnings.length)$('sketch-status').textContent+=' '+result.warnings.map(t).join(' ');draw();
  }
  function accept(){
    if(!preview)throw Error('sketch.previewRequired');if(!$('sketch-confirm').checked||baseline()!==previewBaseline||JSON.stringify(reconstructSketch(read()).spec)!==JSON.stringify(preview.spec)){invalidate();throw Error('sketch.previewStale');}const group=editing||'sketch-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),result=reconstructSketch(preview.spec,{group});
    if(editing){const existing=doc.entities.find(e=>e.group===editing);for(const key of ['layer','hole','name'])if(existing?.[key]!==undefined)result.ops[0][key]=existing[key];}
    const ops=[...(editing?doc.entities.filter(e=>e.group===editing).map(e=>({op:'delete',id:e.id})):[]),...result.ops];const stage=createDoc();stage.entities=structuredClone(doc.entities);stage.timeline=structuredClone(doc.timeline);applyOps(stage,ops);validateSketchRegistry({...doc.sketches,[group]:result.spec},stage.entities);
    pushUndo();const applied=applyOps(doc,ops);doc.sketches ||= {};doc.sketches[group]=result.spec;doc.selectedId=applied.created[0]||null;h.clearReferenceSelection?.();refreshTimeline();cancel();draw();setHint?.(t('sketch.accepted'));
  }
  function renderPreview(result){const stage={entities:previewEntities};const canvas=$('sketch-canvas'),c=canvas.getContext('2d'),all=stage.entities.flatMap(entityPoints),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),scale=Math.min((canvas.width-32)/Math.max(1,maxX-minX),(canvas.height-32)/Math.max(1,maxY-minY));c.clearRect(0,0,canvas.width,canvas.height);for(const e of stage.entities){c.beginPath();entityPoints(e).forEach((p,i)=>{const q=[16+(p[0]-minX)*scale,16+(maxY-p[1])*scale];i?c.lineTo(...q):c.moveTo(...q);});if(isClosed(e))c.closePath();c.strokeStyle='#59ddb7';c.lineWidth=2;c.stroke();}}
  function drawOverlay(){
    if(!ctx||!w2s)return;ctx.save();ctx.strokeStyle='#59ddb7';ctx.fillStyle='#59ddb7';ctx.lineWidth=2;const picks=picking?points:preview?.spec.landmarks||[];ctx.beginPath();picks.forEach((p,i)=>{const s=w2s(p);i?ctx.lineTo(...s):ctx.moveTo(...s);ctx.fillRect(s[0]-4,s[1]-4,8,8);});ctx.setLineDash?.([5,5]);ctx.stroke();if(preview){for(const e of previewEntities){ctx.beginPath();entityPoints(e).forEach((p,i)=>{const s=w2s(p);i?ctx.lineTo(...s):ctx.moveTo(...s);});if(isClosed(e))ctx.closePath();ctx.stroke();}}ctx.restore();
  }
  on('sketch-close',cancel);on('sketch-cancel',cancel);on('sketch-pick',startPick);on('sketch-pick-done',finishPick);on('sketch-pick-cancel',()=>{picking=false;points=[];$('sketch-pick-toolbar').hidden=true;setHint?.('');show();draw();});on('sketch-preview',previewGeometry);on('sketch-accept',accept);on('sketch-reject',()=>{invalidate();status();});
  $('sketch-confirm').addEventListener('change',invalidate);
  $('sketch-kind').addEventListener('change',()=>{draft={version:1,kind:$('sketch-kind').value,...(draft.referenceId?{referenceId:draft.referenceId}:{}),dimensions:{},bindings:{}};editing=null;$('sketch-confirm').checked=false;invalidate();render();});
  dialog.addEventListener('cancel',()=>{picking=false;invalidate();});dialog.addEventListener('close',()=>{if(!picking){invalidate();if(selectionBefore&&doc.entities.some(e=>e.id===selectionBefore)&&!doc.selectedId)doc.selectedId=selectionBefore;}});
  return {open,clickPoint,drawOverlay,cancel,refresh:()=>{cancel();draft=null;editing=null;},editSelected,picking:()=>picking,language:()=>{if(dialog.open){draft=readInputs();render();}}};
}
