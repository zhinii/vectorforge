// Versioned local-only project format. Never stores connection settings or chat.
import { createDoc, applyOps, serializeScene, validateText } from './model.mjs?v=20261023-9';
import { inspectRaster } from './import.mjs?v=20261023-9';
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export function referencePoint(ref, uv) {
  const a = ref.rotation * Math.PI / 180, x = (uv[0] - .5) * ref.width, y = (.5 - uv[1]) * ref.height;
  return [ref.center[0] + x * Math.cos(a) - y * Math.sin(a), ref.center[1] + x * Math.sin(a) + y * Math.cos(a)];
}
export function referenceUV(ref, point) {
  const a = -ref.rotation * Math.PI / 180, x = point[0] - ref.center[0], y = point[1] - ref.center[1];
  return [.5 + (x * Math.cos(a) - y * Math.sin(a)) / ref.width, .5 - (x * Math.sin(a) + y * Math.cos(a)) / ref.height];
}
export function calibrateReference(ref, a, b, known) {
  if (!Number.isFinite(known) || known <= 0 || known > 100000) throw Error('invalid_dimension');
  const pa = referencePoint(ref,a), pb = referencePoint(ref,b), length = Math.hypot(pa[0]-pb[0],pa[1]-pb[1]);
  if (length < .001) throw Error('distinct_points');
  const scale = known / length, width = ref.width * scale, height = ref.height * scale;
  if (![width,height].every(v=>Number.isFinite(v)&&v>=.01&&v<=100000)) throw Error('image_range');
  return {...ref,width,height,calibrated:true};
}
const finite = v => typeof v==='number' && Number.isFinite(v) && Math.abs(v)<=1000000;
const pair = p => Array.isArray(p)&&p.length===2&&p.every(finite);
const label = s => typeof s==='string' && s.length<=120 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(s);
export function validateReferences(refs, annotations=[]) {
  if (!Array.isArray(refs)||refs.length>6||!Array.isArray(annotations)||annotations.length>200) throw Error('project_limit');
  const ids = new Set();
  const references=refs.map(r=>{
    if(!r||typeof r.id!=='string'||!/^[\w-]{1,80}$/.test(r.id)||ids.has(r.id)||!label(r.name)||!pair(r.center)||
      ![r.width,r.height].every(v=>finite(v)&&v>=.01&&v<=100000)||!finite(r.rotation)||typeof r.opacity!=='number'||r.opacity<.05||r.opacity>1||
      typeof r.dataURL!=='string'||r.dataURL.length>4*1024*1024||!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(r.dataURL)) throw Error('invalid_reference');
    const bytes=Uint8Array.from(atob(r.dataURL.split(',')[1]),c=>c.charCodeAt(0)); const meta=inspectRaster(bytes);
    if(meta.width>1024||meta.height>1024)throw Error('reference_dimensions');
    ids.add(r.id);
    return {id:r.id,name:r.name,center:r.center.slice(),width:r.width,height:r.height,rotation:r.rotation,opacity:r.opacity,locked:r.locked!==false,calibrated:r.calibrated===true,dataURL:r.dataURL};
  });
  const seen = new Set();
  const cleanAnnotations=annotations.map(a=>{
    if(!a||typeof a.id!=='string'||!/^[\w-]{1,80}$/.test(a.id)||seen.has(a.id)||!ids.has(a.referenceId)||!['dimension','note'].includes(a.type)||!pair(a.a)||!pair(a.offset)||!label(a.text||'')) throw Error('invalid_annotation');
    if(a.type==='dimension'&&(!pair(a.b)||!finite(a.value)||a.value<=0||a.value>100000))throw Error('invalid_annotation');
    seen.add(a.id);
    return {id:a.id,referenceId:a.referenceId,type:a.type,a:a.a.slice(),...(a.type==='dimension'?{b:a.b.slice(),value:a.value}:{}),offset:a.offset.slice(),text:a.text||''};
  });
  return {references,annotations:cleanAnnotations};
}
export function encodeProject(doc) {
  const extra=validateReferences(doc.references||[],doc.annotations||[]);
  const result=JSON.stringify({format:'VectorForge',version:1,units:'mm',entities:serializeScene(doc).entities,...extra},null,2);
  if(result.length>MAX_PROJECT_BYTES)throw Error('project_limit');
  return result;
}
export function decodeProject(text) {
  if(typeof text!=='string'||text.length>MAX_PROJECT_BYTES)throw Error('project_limit');
  let data;try{data=JSON.parse(text);}catch{throw Error('invalid_project');}
  if(!data||data.format!=='VectorForge'||data.version!==1||data.units!=='mm'||!Array.isArray(data.entities)||data.entities.length>2000)throw Error('invalid_project');
  const extra=validateReferences(data.references||[],data.annotations||[]),doc=createDoc();
  const types=new Set(['path','line','bezier','circle','arc','rect','polygon','star','text']);
  const ops=data.entities.map(e=>{if(!e||typeof e!=='object'||!types.has(e.type))throw Error('invalid_project');return {...e,op:e.type};});
  applyOps(doc,ops,'project');
  Object.assign(doc,extra); return doc;
}
export function annotationLabel(a) {return a.type==='note'?a.text:`${a.value} mm${a.text?' · '+a.text:''}`;}

export function traceOnReference(ops,ref,width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw Error('invalid_raster_size');
  return ops.map(op=>({...op,points:op.points.map(p=>referencePoint(ref,[p[0]/width,1-p[1]/height]))}));
}
