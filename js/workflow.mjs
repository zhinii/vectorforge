import {makeEntity,applyOps,createDoc,entityPoints,isClosed,moveEntity,serializeScene} from './model.mjs?v=20261024-11';
import {parseSVG,traceRaster,loadRasterFile} from './import.mjs?v=20261024-11';
import {listTemplates,generateTemplate} from './templates.mjs?v=20261024-11';
import {preflight} from './preflight.mjs?v=20261024-11';
import {toSVG,toDXF,download} from './dxf.mjs?v=20261024-11';
import {encodeProject,decodeProject,referencePoint,referenceUV,calibrateReference,annotationLabel,traceOnReference,MAX_PROJECT_BYTES} from './project.mjs?v=20261024-11';
import {t,getLanguage,applyTranslations} from './i18n.mjs?v=20261024-11';

// Images and notes live beside geometry, never in the AI scene or cut exports.
export function initWorkflow(h) {
  const {document,window,doc,canvas,ctx,view,w2s,s2w,pushUndo,draw,refreshTimeline,openDialog,wireDialog,setTool,setHint,addMsg}=h;
  doc.references=[];doc.annotations=[];
  const $=id=>document.getElementById(id), dialog=$('workshop-dialog');
  const images=new Map(); let activeRef=null, preview=null, templatePreview=null, pick=null, annotationDraft=null, drag=null, boxes=[], generation=0;
  let section='import';
  const unique=prefix=>prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  const localized=v=>typeof v==='string'?t(v):v?.[getLanguage()]||v?.en||'';
  const ref=()=>doc.references.find(r=>r.id===activeRef);
  const error=e=>{ $('workshop-error').textContent=t('Could not complete that step. Check the file, limits and values.')+' '+String(e?.message||e);$('workshop-error').hidden=false; };
  const clearError=()=>{$('workshop-error').hidden=true;};
  const change=fn=>{pushUndo();fn();refreshTimeline();draw();};
  const button=(id,fn)=>$(id).addEventListener('click',async()=>{clearError();try{await fn();}catch(e){error(e);}});
  const option=(select,value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;select.appendChild(o);};
  function show(which) { section=which;for(const name of ['import','templates','layers','project','checks'])$('workshop-'+name).hidden=name!==which;
    for(const b of document.querySelectorAll('[data-workshop]'))b.classList.toggle('active',b.dataset.workshop===which);
    clearError();if(which==='import')refreshReferences();if(which==='layers')refreshEntities();if(which==='templates')refreshTemplates();if(which==='checks')runChecks();
  }
  function open(which='import'){show(which);openDialog(dialog,$('workshop-close'));}
  wireDialog(dialog,['workshop-close','workshop-cancel']);
  dialog.addEventListener('close',()=>{generation++;preview=null;templatePreview=null;$('import-preview').hidden=true;$('template-result').hidden=true;});
  button('workshop-open',()=>open());button('templates-open',()=>open('templates'));
  for(const b of document.querySelectorAll('[data-workshop]'))b.addEventListener('click',()=>show(b.dataset.workshop));
  button('choose-image',()=>$('image-file').click());button('take-photo',()=>$('camera-file').click());button('choose-svg',()=>$('svg-file').click());
  async function addImage(file){if(!file)return;if(doc.references.length>=6)throw Error(t('Keep at most six reference images per project.'));
    const token=++generation;const result=await loadRasterFile(file,{maxDimension:1024});
    try{if(token!==generation||!dialog.open)return;
      const temp=document.createElement('canvas');temp.width=result.imageData.width;temp.height=result.imageData.height;temp.getContext('2d').putImageData(result.imageData,0,0);
      const dataURL=temp.toDataURL('image/png');if(dataURL.length>4*1024*1024)throw Error(t('Image is too large after decoding. Use a smaller image.'));
      const r={id:unique('image'),name:String(file.name||t('Photo')).replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu,'').slice(0,120),dataURL,center:[0,0],width:150,height:150*temp.height/temp.width,rotation:0,opacity:.55,locked:true,calibrated:false};
      change(()=>{doc.references.push(r);activeRef=r.id;});getImage(r);refreshReferences();fit();
    }finally{result.dispose?.();}
  }
  for(const id of ['image-file','camera-file'])$(id).addEventListener('change',async()=>{const file=$(id).files?.[0];$(id).value='';clearError();try{await addImage(file);}catch(e){error(e);}});
  $('svg-file').addEventListener('change',async()=>{const file=$('svg-file').files?.[0];$('svg-file').value='';if(!file)return;const token=++generation;try{if(file.size>1024*1024)throw Error(t('SVG must be under 1 MB.'));const text=await file.text();if(token!==generation||!dialog.open)return;preview=parseSVG(text,{group:unique('svg')});renderPreview(preview,$('preview-canvas'));$('preview-summary').textContent=t('Review the preview and scale before accepting.')+' '+preview.ops.length+' '+t('objects')+'. '+(preview.warnings||[]).map(localized).join(' ');$('import-preview').hidden=false;}catch(e){error(e);}});
  function getImage(r){let entry=images.get(r.id);if(entry?.src===r.dataURL)return entry;
    const image=new window.Image();entry={image,src:r.dataURL,ready:false};images.set(r.id,entry);image.onload=()=>{entry.ready=true;draw();};image.onerror=()=>{entry.failed=true;};image.src=r.dataURL;return entry;
  }
  function refreshReferences(){const select=$('reference-select');select.textContent='';for(const r of doc.references)option(select,r.id,r.name);if(!ref())activeRef=doc.references[0]?.id||null;select.value=activeRef||'';const r=ref();$('reference-controls').hidden=!r;if(!r)return;
    $('ref-x').value=r.center[0];$('ref-y').value=r.center[1];$('ref-width').value=r.width;$('ref-angle').value=r.rotation;$('ref-opacity').value=r.opacity;$('ref-locked').checked=r.locked;
    $('annotation-select').textContent='';for(const a of doc.annotations.filter(a=>a.referenceId===r.id))option($('annotation-select'),a.id,annotationLabel(a));
    $('reference-status').textContent=t(r.calibrated?'Scale calibrated from a user-confirmed measurement. Perspective is not corrected.':'Scale is unverified. Calibrate a known length before using measurements.');
  }
  $('reference-select').addEventListener('change',()=>{activeRef=$('reference-select').value;preview=null;$('import-preview').hidden=true;refreshReferences();});
  button('reference-apply',()=>{const r=ref();if(!r)return;const x=Number($('ref-x').value),y=Number($('ref-y').value),width=Number($('ref-width').value),rotation=Number($('ref-angle').value),opacity=Number($('ref-opacity').value);
    if(![x,y,rotation].every(v=>Number.isFinite(v)&&Math.abs(v)<=100000)||!Number.isFinite(width)||width<.01||width>100000||width*r.height/r.width>100000||opacity<.05||opacity>1)throw Error(t('Enter finite image settings within the supported range.'));
    change(()=>{const height=width*r.height/r.width;if(width!==r.width)r.calibrated=false;Object.assign(r,{center:[x,y],width,height,rotation,opacity,locked:$('ref-locked').checked});});preview=null;$('import-preview').hidden=true;refreshReferences();
  });
  button('reference-delete',()=>{if(!ref())return;change(()=>{images.delete(activeRef);doc.references=doc.references.filter(r=>r.id!==activeRef);doc.annotations=doc.annotations.filter(a=>a.referenceId!==activeRef);});activeRef=null;refreshReferences();});
  function startPick(kind){if(!ref())return;dialog.close();setTool('select');pick={kind,referenceId:activeRef,points:[]};setHint(t(kind==='note'?'Tap the note position on the image.':'Tap two points on the image. Escape cancels.'));}
  button('annotation-delete',()=>{const id=$('annotation-select').value;if(!id)return;change(()=>{doc.annotations=doc.annotations.filter(a=>a.id!==id);});refreshReferences();});
  button('annotation-edit',()=>{const a=doc.annotations.find(a=>a.id===$('annotation-select').value);if(!a)return;const copy=structuredClone(a);dialog.close();annotationDraft={kind:copy.type,referenceId:copy.referenceId,points:[copy.a,copy.b],existingId:copy.id};$('annotation-value-label').hidden=copy.type==='note';$('annotation-value').value=copy.value||'';$('annotation-text').value=copy.text;$('annotation-error').hidden=true;$('annotation-explanation').textContent=t('This is a user-entered reference annotation, not a driving geometry constraint. Drag its label to reposition.');openDialog(annotationDialog,$('annotation-text'));});
  button('reference-calibrate',()=>startPick('calibrate'));button('reference-measure',()=>startPick('dimension'));button('reference-note',()=>startPick('note'));
  const annotationDialog=$('annotation-dialog');wireDialog(annotationDialog,['annotation-close','annotation-cancel']);
  annotationDialog.addEventListener('close',()=>{annotationDraft=null;pick=null;setHint('');draw();});
  $('annotation-form').addEventListener('submit',ev=>{ev.preventDefault();try{const a=annotationDraft;if(!a)return;const r=doc.references.find(r=>r.id===a.referenceId);if(!r)return;const value=Number($('annotation-value').value),text=$('annotation-text').value.trim();
      if(a.kind==='note'&&!text)throw Error(t('Enter a note.'));if(text.length>120||/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text))throw Error(t('Use a plain single-line note.'));
      if(a.kind!=='note'&&(!Number.isFinite(value)||value<=0||value>100000))throw Error(t('Enter a known positive dimension up to 100,000 mm.'));
      const updated=a.kind==='calibrate'?calibrateReference(r,a.points[0],a.points[1],value):null;
      change(()=>{if(updated)Object.assign(r,updated);const existing=doc.annotations.find(n=>n.id===a.existingId);const next={id:existing?.id||unique('annotation'),referenceId:r.id,type:a.kind==='note'?'note':'dimension',a:a.points[0],...(a.kind==='note'?{}:{b:a.points[1],value}),text,offset:existing?.offset||[14,-18]};if(existing)Object.assign(existing,next);else doc.annotations.push(next);});annotationDialog.close();
    }catch(e){$('annotation-error').textContent=e.message;$('annotation-error').hidden=false;}});
  button('trace-preview',()=>{const r=ref(),entry=r&&getImage(r);if(!r||!entry.ready)throw Error(t('Wait for the image to finish loading.'));
    const temp=document.createElement('canvas'),im=entry.image;temp.width=im.naturalWidth;temp.height=im.naturalHeight;temp.getContext('2d').drawImage(im,0,0);
    const threshold=Number($('trace-threshold').value),minArea=Number($('trace-area').value),simplify=Number($('trace-simplify').value);
    if(!Number.isFinite(threshold)||threshold<0||threshold>255||!Number.isFinite(minArea)||minArea<0||minArea>10000||!Number.isFinite(simplify)||simplify<0||simplify>5)throw Error(t('Check the trace settings.'));
    const result=traceRaster(temp.getContext('2d').getImageData(0,0,temp.width,temp.height),{threshold,thresholdMode:$('trace-mode').value||'global',minArea,simplify,invert:$('trace-invert').checked,mmPerPixel:1,group:unique('trace')});
    // Trace output uses image pixel x and upward image y, then follows the underlay transform exactly.
    result.ops=traceOnReference(result.ops,r,temp.width,temp.height);
    preview=result;renderPreview(preview,$('preview-canvas'));$('preview-summary').textContent=t('Review the preview and scale before accepting.')+' '+result.ops.length+' '+t('contours')+'. '+t('Thick strokes may create double edges.');$('import-preview').hidden=false;
  });
  button('preview-cancel',()=>{preview=null;$('import-preview').hidden=true;});
  button('preview-accept',()=>{if(!preview)return;acceptOps(preview.ops);preview=null;$('import-preview').hidden=true;dialog.close();fit();});
  function acceptOps(ops){const staged=createDoc();staged.entities=structuredClone(doc.entities);applyOps(staged,ops);change(()=>{const result=applyOps(doc,ops,'import');doc.selectedId=result.created[0]||null;});}
  function renderPreview(result,target){const temp=createDoc();applyOps(temp,result.ops);const points=temp.entities.flatMap(entityPoints);const c=target.getContext('2d');c.clearRect(0,0,target.width,target.height);if(!points.length)return;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}const scale=Math.min((target.width-30)/Math.max(1,maxX-minX),(target.height-30)/Math.max(1,maxY-minY));
    for(const e of temp.entities){if(e.type==='text')continue;c.beginPath();entityPoints(e).forEach((p,i)=>{const x=15+(p[0]-minX)*scale,y=15+(maxY-p[1])*scale;i?c.lineTo(x,y):c.moveTo(x,y);});if(isClosed(e))c.closePath();c.strokeStyle=e.layer==='reference'?'#637a96':e.layer==='engrave'?'#69c8ef':'#ffb84d';c.lineWidth=1;c.stroke();}
  }
  function refreshTemplates(){const selected=$('template-select').value,select=$('template-select');select.textContent='';const templates=listTemplates();for(const item of templates)option(select,item.id,localized(item.title));select.value=templates.some(t=>t.id===selected)?selected:templates[0]?.id;templateFields();}
  function templateFields(){const item=listTemplates().find(t=>t.id===$('template-select').value);$('template-fields').textContent='';templatePreview=null;$('template-result').hidden=true;if(!item)return;$('template-description').textContent=localized(item.description);for(const p of item.parameters){const label=document.createElement('label'),span=document.createElement('span'),input=document.createElement('input');span.textContent=localized(p.label)+(p.unit?' ('+p.unit+')':'');input.type='number';input.id='template-param-'+p.key;input.value=p.default;input.min=p.min;input.max=p.max;input.step=p.step||'any';input.dataset.parameter=p.key;label.append(span,input);$('template-fields').appendChild(label);}}
  $('template-select').addEventListener('change',templateFields);
  button('template-preview',()=>{const template=listTemplates().find(t=>t.id===$('template-select').value);const values={};for(const p of template.parameters){const input=document.getElementById('template-param-'+p.key);values[p.key]=Number(input.value);}templatePreview=generateTemplate(template.id,values);const group=unique('template');templatePreview.ops=templatePreview.ops.map(op=>({...op,group:group+(op.group?'-'+op.group:'')}));renderPreview(templatePreview,$('template-canvas'));$('template-notes').textContent=[...(templatePreview.warnings||[]),...(templatePreview.notes||[])].map(localized).join(' ');$('template-result').hidden=false;});
  button('template-accept',()=>{if(!templatePreview)return;acceptOps(templatePreview.ops);dialog.close();fit();});
  function refreshEntities(){const select=$('entity-select');select.textContent='';for(const e of doc.entities)option(select,e.id,`${e.id} · ${e.name||t(e.type)} · ${t(e.layer||'cut')}`);select.value=doc.selectedId||doc.entities[0]?.id||'';entityFields();}
  function entityFields(){const e=doc.entities.find(e=>e.id===$('entity-select').value);if(!e)return;doc.selectedId=e.id;$('entity-layer').value=e.layer||'cut';$('entity-group').value=e.group||'';$('entity-hole').checked=!!e.hole;$('entity-closed').disabled=e.type!=='path';$('entity-closed').checked=isClosed(e);draw();}
  $('entity-select').addEventListener('change',entityFields);
  button('entity-apply',()=>{const id=$('entity-select').value;if(!id)return;const op={op:'set_metadata',id,layer:$('entity-layer').value,group:$('entity-group').value,hole:$('entity-hole').checked};const staged=createDoc();staged.entities=structuredClone(doc.entities);applyOps(staged,[op]);const e=doc.entities.find(e=>e.id===id);if(e.type==='path')makeEntity('path',{...e,closed:$('entity-closed').checked});change(()=>{applyOps(doc,[op]);if(e.type==='path')e.closed=$('entity-closed').checked;});refreshEntities();});
  button('project-save',()=>download('drawing.vforge',encodeProject(doc),'application/json'));
  button('project-open',()=>$('project-file').click());
  $('project-file').addEventListener('change',async()=>{const file=$('project-file').files?.[0];$('project-file').value='';if(!file)return;const token=++generation;try{if(file.size>MAX_PROJECT_BYTES)throw Error(t('Project exceeds 16 MB.'));const text=await file.text();if(token!==generation||!dialog.open)return;const loaded=decodeProject(text);change(()=>Object.assign(doc,loaded));images.clear();activeRef=doc.references[0]?.id;dialog.close();fit();}catch(e){error(e);}});
  function runChecks(){const width=$('bed-width').value,height=$('bed-height').value;const report=preflight(doc,{...(width?{bedWidth:Number(width)}:{}),...(height?{bedHeight:Number(height)}:{})});$('checks-list').textContent='';$('export-reviewed').checked=false;
    $('checks-summary').textContent=`${report.counts?.exported??0} ${t('exported objects')} · ${t('Units: mm')} · ${report.bounds?Math.round(report.bounds.width*100)/100+' × '+Math.round(report.bounds.height*100)/100+' mm':''}`;
    for(const issue of report.issues.slice(0,100)){const li=document.createElement('li');li.textContent=t('severity.'+issue.severity)+' · '+(issue.entityId?issue.entityId+': ':'')+t('check.'+issue.code);$('checks-list').appendChild(li);}if(!(doc.references||[]).every(r=>r.calibrated)) {const li=document.createElement('li');li.textContent=t('An image has unverified scale. Calibrate it before fabrication.');$('checks-list').appendChild(li);}const limits=document.createElement('li');limits.textContent=report.limitations.map(t).join(' ');$('checks-list').appendChild(limits);return report;}
  button('checks-run',runChecks);
  function checkedExport(format){if(!$('export-reviewed').checked)throw Error(t('Review the warnings and check the acknowledgement first.'));const report=preflight(doc,{...($('bed-width').value?{bedWidth:Number($('bed-width').value)}:{}),...($('bed-height').value?{bedHeight:Number($('bed-height').value)}:{})});if(report.issues.some(i=>i.severity==='error'))throw Error(t('Resolve drawing errors before export.'));download('design.'+format,format==='svg'?toSVG(doc):toDXF(doc),format==='svg'?'image/svg+xml':'application/dxf');}
  button('checked-svg',()=>checkedExport('svg'));button('checked-dxf',()=>checkedExport('dxf'));
  button('annotated-export',()=>download('drawing-reference.svg',annotatedSVG(),'image/svg+xml'));
  function annotatedSVG(){let svg=toSVG(doc,{includeReference:true});const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));const pieces=[];let points=doc.entities.flatMap(entityPoints);
    for(const r of doc.references){points.push(...[[0,0],[1,0],[1,1],[0,1]].map(p=>referencePoint(r,p)));pieces.push(`<image x="${-r.width/2}" y="${-r.height/2}" width="${r.width}" height="${r.height}" opacity="${r.opacity}" transform="translate(${r.center[0]} ${-r.center[1]}) rotate(${-r.rotation})" href="${r.dataURL}"/>`);}
    for(const a of doc.annotations){const r=doc.references.find(r=>r.id===a.referenceId);if(!r)continue;const p=referencePoint(r,a.a),q=a.b?referencePoint(r,a.b):p;const at=[(p[0]+q[0])/2+a.offset[0]/view.s,(p[1]+q[1])/2-a.offset[1]/view.s];points.push(at);if(a.b)pieces.push(`<path d="M ${p[0]} ${-p[1]} L ${q[0]} ${-q[1]}" stroke="#14805e" fill="none" stroke-width="0.3"/>`);pieces.push(`<text x="${at[0]}" y="${-at[1]}" font-size="4" fill="#14805e">${esc(annotationLabel(a))}</text>`);}
    if(points.length){const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);const minX=Math.min(...xs)-10,maxX=Math.max(...xs)+30,minY=Math.min(...ys)-10,maxY=Math.max(...ys)+10;svg=svg.replace(/viewBox="[^"]*" width="[^"]*" height="[^"]*"/,`viewBox="${minX} ${-maxY} ${maxX-minX} ${maxY-minY}" width="${maxX-minX}mm" height="${maxY-minY}mm"`);}return svg.replace(/(<svg[^>]*>)/,`$1\n<!-- REFERENCE DOCUMENT: not a machine cutting file -->\n<g id="reference-images-and-notes">${pieces.join('\n')}</g>`);}
  function fit(){const points=doc.entities.flatMap(entityPoints);for(const r of doc.references)points.push(...[[0,0],[1,0],[1,1],[0,1]].map(p=>referencePoint(r,p)));if(!points.length)return;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);}view.s=Math.max(.05,Math.min(200,(canvas.clientWidth-50)/Math.max(1,maxX-minX),(canvas.clientHeight-70)/Math.max(1,maxY-minY)));view.ox=canvas.clientWidth/2-(minX+maxX)/2*view.s;view.oy=canvas.clientHeight/2+(minY+maxY)/2*view.s;draw();}
  function drawUnderlay(){for(const r of doc.references||[]){const entry=getImage(r);if(!entry.ready)continue;const center=w2s(r.center);ctx.save();ctx.translate(...center);ctx.rotate(-r.rotation*Math.PI/180);ctx.globalAlpha=r.opacity;ctx.drawImage(entry.image,-r.width*view.s/2,-r.height*view.s/2,r.width*view.s,r.height*view.s);ctx.restore();}}
  function drawAnnotations(){boxes=[];ctx.save();ctx.font='12px system-ui';for(const a of doc.annotations||[]){const r=doc.references.find(r=>r.id===a.referenceId);if(!r)continue;const p=w2s(referencePoint(r,a.a)),q=a.b?w2s(referencePoint(r,a.b)):p;const center=[(p[0]+q[0])/2,(p[1]+q[1])/2],at=center.map((v,i)=>v+a.offset[i]);ctx.strokeStyle='#76d9b0';ctx.beginPath();ctx.moveTo(...p);ctx.lineTo(...q);ctx.moveTo(...center);ctx.lineTo(...at);ctx.stroke();const text=annotationLabel(a),width=ctx.measureText(text).width+12;ctx.fillStyle='#113129';ctx.fillRect(at[0]-4,at[1]-15,width,22);ctx.fillStyle='#a5ecd0';ctx.fillText(text,at[0]+2,at[1]);boxes.push({a,x:at[0]-4,y:at[1]-15,w:width,h:22});}if(pick){ctx.fillStyle='#76d9b0';const r=doc.references.find(r=>r.id===pick.referenceId);for(const p of pick.points){const s=w2s(referencePoint(r,p));ctx.fillRect(s[0]-4,s[1]-4,8,8);}}ctx.restore();}
  function clickPoint(world){if(!pick)return false;const r=doc.references.find(r=>r.id===pick.referenceId);if(!r){pick=null;return false;}pick.points.push(referenceUV(r,world));if(pick.points.length<(pick.kind==='note'?1:2)){draw();return true;}annotationDraft=pick;pick=null;$('annotation-value-label').hidden=annotationDraft.kind==='note';$('annotation-value').value='';$('annotation-text').value='';$('annotation-error').hidden=true;$('annotation-explanation').textContent=t(annotationDraft.kind==='calibrate'?'Enter the real distance. This rescales only this image and its attached annotations, not existing vector paths.':'This is a user-entered reference annotation, not a driving geometry constraint. Drag its label to reposition.');openDialog(annotationDialog,$(annotationDraft.kind==='note'?'annotation-text':'annotation-value'));return true;}
  function pointerDown(s,ev){if(pick)return false;if(ev.button!==0)return false;const box=boxes.find(b=>s[0]>=b.x-5&&s[0]<=b.x+b.w+5&&s[1]>=b.y-5&&s[1]<=b.y+b.h+5);if(box){drag={type:'annotation',object:box.a,start:s,offset:box.a.offset.slice(),id:ev.pointerId};return true;}for(const r of [...doc.references].reverse()){if(r.locked)continue;const uv=referenceUV(r,s2w(s));if(uv.every(v=>v>=0&&v<=1)){drag={type:'image',object:r,start:s,center:r.center.slice(),id:ev.pointerId};return true;}}return false;}
  function pointerMove(s,ev){if(!drag||drag.id!==ev.pointerId)return false;if(Math.hypot(s[0]-drag.start[0],s[1]-drag.start[1])<4&&!drag.changed)return true;if(!drag.changed){pushUndo();drag.changed=true;}if(drag.type==='annotation')drag.object.offset=drag.offset.map((v,i)=>v+s[i]-drag.start[i]);else drag.object.center=[drag.center[0]+(s[0]-drag.start[0])/view.s,drag.center[1]-(s[1]-drag.start[1])/view.s];draw();return true;}
  function pointerEnd(){const had=!!drag;drag=null;return had;}
  return {open,drawUnderlay,drawAnnotations,clickPoint,picking:()=>!!pick,pointerDown,pointerMove,pointerEnd,cancel:()=>{pick=null;drag=null;setHint('');draw();},refresh:()=>{images.clear();activeRef=doc.references?.[0]?.id||null;},groupMove:()=>$('group-move').checked,language:()=>{if(dialog.open)show(section);},fit};
}
