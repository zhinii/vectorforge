import {simplifyGuidedSegment} from './guided-simplify.mjs?v=20261024-14';
import {prepareGuidedImage,traceGuidedSegment} from './guided-trace.mjs?v=20261024-14';
import {applyOps} from './model.mjs?v=20261024-14';
import {referencePoint,referenceUV,calibrateReference} from './project.mjs?v=20261024-14';

export const MAX_GUIDED_ANCHORS=64, MAX_GUIDED_POINTS=512;
const pair=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
const uvPair=p=>[p.x,p.y], uvObject=p=>({x:p[0],y:p[1]});
// Local-only controller. Neither tracing nor calibration mutates the document
// until acceptance; pending raster/hover jobs are invalidated by generation.
export function initGuidedTrace(h){
  const {document,doc}=h,$=id=>document.getElementById(id),t=h.t||((key)=>key);
  let session=null,generation=0,hoverGeneration=0,hoverTimer=null;
  const refMetadata=()=>JSON.stringify((doc.references||[]).map(({dataURL,...ref})=>ref));
  const fingerprint=()=>JSON.stringify({entities:doc.entities,timeline:doc.timeline,references:refMetadata(),annotations:doc.annotations||[],sketches:doc.sketches||{}});
  const sources=()=>new Map((doc.references||[]).map(r=>[r.id,r.dataURL]));
  const say=(id,key)=>{if($(id))$(id).textContent=t(key);};
  const hide=(id,value)=>{if($(id))$(id).hidden=value;};
  const disable=(id,value)=>{if($(id))$(id).disabled=value;};
  function error(key){hide('guided-trace-error',false);say('guided-trace-error',key);}
  function clearError(){hide('guided-trace-error',true);}
  function render(){
    hide('guided-trace-toolbar',!session);if(!session)return;
    const s=session,editing=s.phase==='trace',scale=s.phase==='scale'||s.phase==='measure';
    hide('guided-trace-suggest',!editing||!s.suggestion);hide('guided-trace-approximate',!s.approximate.some(Boolean));
    hide('guided-trace-scale',!scale);hide('guided-trace-measurement-fields',s.measure.length!==2);
    for(const id of ['guided-trace-undo','guided-trace-finish','guided-trace-close'])hide(id,!editing);
    disable('guided-trace-undo',!s.anchors.length||s.busy);
    disable('guided-trace-finish',s.anchors.length<2||s.busy||!!s.suggestion);
    disable('guided-trace-close',s.anchors.length<3||s.busy||!!s.suggestion);
    disable('guided-trace-accept',!s.scaleReady||s.phase==='measure'||s.busy);
    disable('guided-trace-apply-scale',s.measure.length!==2||s.phase==='measure');
    hide('guided-trace-unverified',s.ref.calibrated===true);
    say('guided-trace-status',s.phase==='loading'?'guided.loading':s.phase==='measure'?(s.measure.length?'guided.measureSecond':'guided.measureFirst'):scale?'guided.review':s.busy?'guided.finding':s.anchors.length?'guided.next':'guided.first');
    if(editing&&s.anchors.length)$('guided-trace-status').textContent+=' '+s.anchors.length+' / '+MAX_GUIDED_ANCHORS;
    say('guided-trace-accept',s.scaleMode==='unscaled'?'guided.acceptUnscaled':'guided.accept');
    hide('guided-trace-scale-warning',s.scaleMode!=='measure');
    say('guided-trace-scale-status',s.scaleReady?(s.scaleMode==='measure'?'guided.scaleStaged':s.ref.calibrated?'guided.calibrated':'guided.unscaled'):'guided.scaleNeeded');
  }
  function fresh(s=session,deep=true){
    if(!s||s!==session||s.generation!==generation||s.refMetadata!==refMetadata()||(doc.references||[]).length!==s.sources.size||!(doc.references||[]).every(r=>s.sources.get(r.id)===r.dataURL))return false;
    if(doc.entities!==s.entityArray||doc.timeline!==s.timelineArray||doc.annotations!==s.annotationArray||doc.sketches!==s.sketchObject)return false;
    return !deep||s.baseline===fingerprint();
  }
  function failure(key){cancel();hide('guided-trace-toolbar',false);hide('guided-trace-scale',true);for(const id of ['guided-trace-undo','guided-trace-finish','guided-trace-close','guided-trace-suggest','guided-trace-approximate'])hide(id,true);say('guided-trace-status','');error(key);h.setHint?.(t(key));}
  function stale(){failure('guided.stale');}
  function check(s=session,deep=true){if(!fresh(s,deep)){if(s===session)stale();return false;}return true;}
  function stopHover(){hoverGeneration++;clearTimeout(hoverTimer);hoverTimer=null;if(session)session.hover=null;}
  function cancel(){session?.abort.abort();generation++;stopHover();session=null;hide('guided-trace-toolbar',true);clearError();h.setHint?.('');h.draw?.();}
  async function start(referenceId){
    cancel();const ref=(doc.references||[]).find(r=>r.id===referenceId);
    if(!ref||!pair(ref.center)||![ref.width,ref.height].every(n=>Number.isFinite(n)&&n>0)){failure('guided.noImage');return false;}
    h.setTool?.('select');const s=session={abort:new AbortController(),generation:++generation,baseline:fingerprint(),refMetadata:refMetadata(),sources:sources(),entityArray:doc.entities,timelineArray:doc.timeline,annotationArray:doc.annotations,sketchObject:doc.sketches,ref:structuredClone(ref),phase:'loading',anchors:[],segments:[],approximate:[],suggestion:null,hover:null,prepared:null,busy:false,closed:false,measure:[],scaleReady:false,scaleMode:null,stagedRef:null};
    $('guided-trace-length').value='';$('guided-trace-unverified').checked=false;render();h.draw?.();
    try{const raster=await h.getRaster(referenceId);if(!check(s))return false;s.prepared=prepareGuidedImage(raster);if(!check(s))return false;s.phase='trace';render();h.draw?.();return true;}
    catch(e){if(s===session){failure('guided.rasterError');}return false;}
  }
  function inside(world,s=session){
    if(!pair(world))return null;const uv=referenceUV(s.ref,world);
    return uv.every(n=>Number.isFinite(n)&&n>=0&&n<=1)?uv:null;
  }
  function flattened(s=session,extra=null){
    if(!s.anchors.length)return [];const points=[s.anchors[0]];
    for(const segment of s.segments)points.push(...segment.slice(1));
    if(extra)points.push(...extra.slice(1));
    return points;
  }
  function solve(s,from,to){return traceGuidedSegment(s.prepared,uvObject(from),uvObject(to),{signal:s.abort.signal});}
  function validSegment(result){return result&&!result.uncertain&&Array.isArray(result.pointsUV)&&result.pointsUV.length>=2&&result.pointsUV.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);}
  async function addSegment(s,uv,closing=false){
    stopHover();s.busy=true;render();
    // Yield so taps and cancellation never leave an unhandled promise.
    await Promise.resolve();if(!check(s))return false;
    try{
      const result=solve(s,s.anchors.at(-1),uv);if(!check(s))return false;
      if(!validSegment(result)){s.suggestion={points:[s.anchors.at(-1).slice(),uv.slice()],uv:uv.slice(),closing};error('guided.uncertain');return false;}
      const points=simplifyGuidedSegment(result.pointsUV.map(uvPair),s.prepared);
      if(flattened(s,points).length>MAX_GUIDED_POINTS){error('guided.pointLimit');return false;}
      s.segments.push(points);s.approximate.push(false);if(!closing)s.anchors.push(uv);else{s.closed=true;finishScale(s);}
      clearError();return true;
    }catch{if(s===session)error('guided.pointLimit');return false;}
    finally{if(s===session){s.busy=false;render();h.draw?.();}}
  }
  function clickPoint(world){
    if(!session)return false;const s=session;if(!check(s))return true;
    if(s.phase==='loading'||s.busy)return true;
    if(!['trace','measure'].includes(s.phase))return true;
    const uv=inside(world,s);if(!uv){error('guided.inside');return true;}
    clearError();
    if(s.phase==='measure'){
      if(s.measure.length&&Math.hypot(...uv.map((v,i)=>v-s.measure[0][i]))<1e-6){error('guided.distinct');return true;}
      s.measure.push(uv);if(s.measure.length===2){s.phase='scale';if($('guided-trace-length').value.trim())stageMeasurement();}render();h.draw?.();return true;
    }
    s.suggestion=null;
    if(s.anchors.length&&Math.hypot(...uv.map((v,i)=>v-s.anchors.at(-1)[i]))<1e-6){render();h.draw?.();return true;}
    if(s.anchors.length>=MAX_GUIDED_ANCHORS){error('guided.anchorLimit');return true;}
    if(!s.anchors.length){s.anchors.push(uv);render();h.draw?.();}
    else void addSegment(s,uv);
    return true;
  }
  function movePoint(world){
    const s=session;if(!s||s.phase!=='trace'||s.busy||s.suggestion||!s.anchors.length)return false;
    if(!check(s,false))return true;const uv=inside(world,s);stopHover();if(!uv){h.draw?.();return true;}
    const token=hoverGeneration;
    hoverTimer=setTimeout(()=>{
      hoverTimer=null;if(s!==session||token!==hoverGeneration||!check(s,false))return;
      try{const result=solve(s,s.anchors.at(-1),uv);if(s!==session||token!==hoverGeneration||!check(s,false))return;
        s.hover={points:(result.pointsUV||[]).slice(0,MAX_GUIDED_POINTS).map(uvPair),uncertain:!validSegment(result)};
      }catch{s.hover=null;}
      h.draw?.();
    },60);return true;
  }
  function useSuggestion(){
    const s=session;if(!s||!check(s)||s.phase!=='trace'||s.busy||!s.suggestion)return false;
    const candidate=s.suggestion;if(flattened(s,candidate.points).length>MAX_GUIDED_POINTS){error('guided.pointLimit');return false;}
    s.segments.push(candidate.points);s.approximate.push(true);s.suggestion=null;
    if(candidate.closing){s.closed=true;finishScale(s);}else s.anchors.push(candidate.uv);
    clearError();render();h.draw?.();return true;
  }
  function undoPoint(){const s=session;if(!s||!check(s)||s.busy)return false;stopHover();if(s.phase!=='trace')return editTrace();if(s.suggestion){s.suggestion=null;}else if(s.anchors.length){s.anchors.pop();s.segments.pop();s.approximate.pop();}clearError();render();h.draw?.();return true;}
  function finishScale(s){s.phase='scale';s.measure=[];s.scaleReady=true;s.scaleMode=s.ref.calibrated?'keep':'unscaled';s.stagedRef=structuredClone(s.ref);}
  async function finish(closed=false){
    const s=session;if(!s||!check(s)||s.phase!=='trace'||s.busy||s.suggestion)return false;
    if(s.anchors.length<(closed?3:2)){error('guided.morePoints');return false;}
    if(closed)return addSegment(s,s.anchors[0],true);
    stopHover();s.closed=false;finishScale(s);clearError();render();h.draw?.();return true;
  }
  function editTrace(){const s=session;if(!s||!check(s)||s.busy)return false;stopHover();if(s.closed){s.segments.pop();s.approximate.pop();}s.suggestion=null;s.closed=false;s.phase='trace';s.scaleReady=false;s.stagedRef=null;s.scaleMode=null;s.measure=[];clearError();render();h.draw?.();return true;}
  function beginMeasurement(){const s=session;if(!s||!check(s)||!['scale','measure'].includes(s.phase))return false;s.phase='measure';s.measure=[];s.scaleReady=false;s.scaleMode='measure';s.stagedRef=null;$('guided-trace-length').value='';clearError();render();h.draw?.();return true;}
  function stageMeasurement(){
    const s=session;if(!s||!check(s)||s.phase!=='scale'||s.measure.length!==2)return false;
    try{const raw=$('guided-trace-length').value;if(typeof raw!=='string'||!raw.trim())throw Error();const value=Number(raw);
      s.stagedRef=calibrateReference(s.ref,s.measure[0],s.measure[1],value);s.scaleReady=true;s.scaleMode='measure';s.scaleInput=raw;clearError();render();h.draw?.();return true;
    }catch{s.scaleReady=false;s.stagedRef=null;error('guided.invalidLength');render();return false;}
  }
  function keepScale(){const s=session;if(!s||!check(s)||s.phase!=='scale')return false;if(!s.ref.calibrated&&!$('guided-trace-unverified').checked){error('guided.ackScale');return false;}s.stagedRef=structuredClone(s.ref);s.scaleMode='keep';s.scaleReady=true;clearError();render();h.draw?.();return true;}
  function accept(){
    const s=session;if(!s||!check(s)||s.phase!=='scale'||s.busy)return false;
    if(!s.scaleReady||!s.stagedRef){error('guided.scaleNeeded');return false;}
    if((s.scaleMode==='measure'&&s.scaleInput!==$('guided-trace-length').value)||(s.scaleMode==='keep'&&!s.ref.calibrated&&!$('guided-trace-unverified').checked)){s.scaleReady=false;render();error('guided.scaleNeeded');return false;}
    try{
      let points=flattened(s);if(s.closed&&points.length>1&&Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<1e-9)points=points.slice(0,-1);
      if(points.length<(s.closed?3:2)||points.length>MAX_GUIDED_POINTS)throw Error();
      const world=points.map(p=>referencePoint(s.stagedRef,p));if(world.some(p=>!pair(p)||p.some(v=>Math.abs(v)>1000000)))throw Error();
      const stage={entities:structuredClone(doc.entities),timeline:structuredClone(doc.timeline),selectedId:doc.selectedId};
      // applyOps is invoked exactly once on the staging copy. The validated
      // result is installed atomically, so ID allocation cannot differ at commit.
      const result=applyOps(stage,[{op:'path',points:world,closed:s.closed,layer:s.closed?'cut':'engrave',hole:false,name:t(s.closed?'guided.outlineName':'guided.lineName')+(s.approximate.some(Boolean)?' '+t('guided.approximateName'):'')}],'guided trace');
      if(!check(s))return false;
      const refs=doc.references.map(r=>r.id===s.ref.id?structuredClone(s.stagedRef):r);
      h.pushUndo();doc.entities=stage.entities;doc.timeline=stage.timeline;doc.references=refs;doc.selectedId=result.created[0];doc.selectedReferenceId=null;
      cancel();h.clearReferenceSelection?.();h.onAccepted?.(s.ref,s.stagedRef);h.refreshTimeline?.();h.draw?.();h.setHint?.(t('guided.accepted'));return true;
    }catch{error('guided.invalidPath');return false;}
  }
  function drawOverlay(){
    const s=session;if(!s||!h.ctx||!h.w2s)return;if(!fresh(s,false)){s.abort.abort();session=null;generation++;stopHover();hide('guided-trace-toolbar',false);hide('guided-trace-scale',true);for(const id of ['guided-trace-undo','guided-trace-finish','guided-trace-close','guided-trace-suggest','guided-trace-approximate'])hide(id,true);say('guided-trace-status','');error('guided.stale');return;}
    const c=h.ctx,toScreen=p=>h.w2s(referencePoint(s.ref,p));
    function path(points,color,dashed=false){if(points.length<2)return;c.beginPath();points.forEach((p,i)=>i?c.lineTo(...toScreen(p)):c.moveTo(...toScreen(p)));c.strokeStyle=color;c.lineWidth=2;c.setLineDash?.(dashed?[5,4]:[]);c.stroke();}
    c.save();s.segments.forEach((segment,i)=>path(segment,s.approximate[i]?'#f4ad57':'#59ddb7',s.approximate[i]));if(s.suggestion)path(s.suggestion.points,'#f4ad57',true);if(s.hover&&!s.suggestion)path(s.hover.points,s.hover.uncertain?'#f4ad57':'#9de9ce',true);c.setLineDash?.([]);
    for(const p of s.anchors){const q=toScreen(p);c.fillStyle='#59ddb7';c.fillRect(q[0]-4,q[1]-4,8,8);}
    path(s.measure,'#85b9ff',true);for(const p of s.measure){const q=toScreen(p);c.fillStyle='#85b9ff';c.fillRect(q[0]-5,q[1]-5,10,10);}c.restore();
  }
  const bind=(id,fn)=>$(id)?.addEventListener('click',()=>{try{const result=fn();if(result?.catch)result.catch(()=>error('guided.invalidPath'));}catch{error('guided.invalidPath');}});
  bind('guided-trace-suggest',useSuggestion);bind('guided-trace-cancel',cancel);bind('guided-trace-undo',undoPoint);bind('guided-trace-finish',()=>finish());bind('guided-trace-close',()=>finish(true));bind('guided-trace-edit',editTrace);bind('guided-trace-measure',beginMeasurement);bind('guided-trace-apply-scale',stageMeasurement);bind('guided-trace-keep-scale',keepScale);bind('guided-trace-accept',accept);
  $('guided-trace-length')?.addEventListener('input',()=>{if(session?.scaleMode==='measure'){session.scaleReady=false;session.stagedRef=null;stageMeasurement();render();}});
  $('guided-trace-unverified')?.addEventListener('change',()=>{if(session?.scaleMode==='keep'&&!session.ref.calibrated){session.scaleReady=false;render();}});
  return {start,clickPoint,movePoint,drawOverlay,useSuggestion,cancel,active:()=>!!session,refresh:cancel,language:render,undoPoint,finish,beginMeasurement,stageMeasurement,keepScale,editTrace,accept,state:()=>session?{phase:session.phase,anchorCount:session.anchors.length,pointCount:flattened().length,suggestion:!!session.suggestion,approximateCount:session.approximate.filter(Boolean).length,busy:session.busy,closed:session.closed,scaleReady:session.scaleReady,hover:session.hover?structuredClone(session.hover):null}:null};
}
