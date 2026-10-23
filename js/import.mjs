/** Local-only, strict geometry import and bounded silhouette tracing. No DOM insertion or network. */
const MM_PER_PX = 25.4 / 96;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_POINTS = 12000;
const MAX_PATH_POINTS = 4096;
const MAX_COORD = 1e7;
const IDENT = [1, 0, 0, 1, 0, 0];
const fail = message => { throw new Error(message); };
const finite = (v, label = 'Number') => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_COORD) fail(`${label} is invalid or out of range.`);
  return v;
};
const number = (s, fallback) => {
  if (s === undefined && fallback !== undefined) return fallback;
  if (typeof s !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s.trim())) fail(`Invalid SVG number: ${String(s).slice(0, 40)}`);
  return finite(Number(s));
};
const numbers = s => {
  const parts = String(s).match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[^\s,]+/gi) || [];
  return parts.map(x => number(x));
};
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]].map(v => finite(v, 'Transform'));
const point = (m, p) => [finite(m[0]*p[0]+m[2]*p[1]+m[4], 'Coordinate'), finite(m[1]*p[0]+m[3]*p[1]+m[5], 'Coordinate')];
const area = p => p.reduce((sum, v, i) => { const w = p[(i+1)%p.length]; return sum + v[0]*w[1]-w[0]*v[1]; }, 0)/2;
const equal = (a,b) => a[0] === b[0] && a[1] === b[1];
function boundsOf(ops) {
  if (!ops.length) return null;
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const op of ops) for (const [x,y] of op.points) { minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); }
  return {minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY};
}
function optionsFor(options) {
  const layer=options.layer ?? 'cut', group=options.group ?? 'import';
  if (!['cut','engrave','reference'].includes(layer)) fail('Invalid import layer.');
  if (typeof group !== 'string' || group.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\uFFFE\uFFFF]/u.test(group)) fail('Invalid import group.');
  return {layer,group};
}
function transform(s) {
  if (!s) return IDENT;
  let m=IDENT, end=0, count=0;
  const re=/([a-zA-Z]+)\s*\(([^()]*)\)/g;
  for (const match of s.matchAll(re)) {
    if (s.slice(end,match.index).replace(/[\s,]/g,'')) fail('Malformed SVG transform.');
    if (++count>64) fail('Too many SVG transforms.');
    const a=numbers(match[2]); let t;
    switch(match[1]) {
      case 'matrix': if(a.length!==6) fail('matrix needs six values.'); t=a; break;
      case 'translate': if(a.length<1||a.length>2) fail('translate needs one or two values.'); t=[1,0,0,1,a[0],a[1]??0]; break;
      case 'scale': if(a.length<1||a.length>2) fail('scale needs one or two values.'); t=[a[0],0,0,a[1]??a[0],0,0]; break;
      case 'rotate': {
        if(a.length!==1&&a.length!==3) fail('rotate needs one or three values.');
        const r=a[0]*Math.PI/180,c=Math.cos(r),s=Math.sin(r); t=[c,s,-s,c,0,0];
        if(a.length===3) t=mul(mul([1,0,0,1,a[1],a[2]],t),[1,0,0,1,-a[1],-a[2]]); break;
      }
      case 'skewX': case 'skewY': {
        if(a.length!==1||Math.abs(Math.cos(a[0]*Math.PI/180))<1e-6) fail('Invalid skew transform.');
        const n=Math.tan(a[0]*Math.PI/180); t=match[1]==='skewX'?[1,0,n,1,0,0]:[1,n,0,1,0,0]; break;
      }
      default: fail(`Unsupported SVG transform: ${match[1]}`);
    }
    m=mul(m,t); end=match.index+match[0].length;
  }
  if(s.slice(end).trim()) fail('Malformed SVG transform.');
  const det=m[0]*m[3]-m[1]*m[2];
  if(!Number.isFinite(det)||Math.abs(det)<1e-12) fail('Singular or excessively small SVG transform.');
  return m;
}
function lengthMM(s) {
  const match=String(s).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|in|pt|pc|px|q)?$/i);
  if(!match) fail('SVG dimensions must use absolute units (mm, cm, in, pt, pc, px), not percentages.');
  const factors={mm:1,cm:10,in:25.4,pt:25.4/72,pc:25.4/6,px:MM_PER_PX,q:.25};
  const value=finite(number(match[1])*factors[(match[2]||'px').toLowerCase()]);
  if(value<=0) fail('SVG dimensions must be positive.'); return value;
}
function userLength(s, fallback=0) {
  if(s===undefined)return fallback;
  if(/(?:mm|cm|in|pt|pc|px|q)$/i.test(s.trim())) {
    const match=s.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|in|pt|pc|px|q)$/i);
    if(!match)fail('Invalid SVG geometry length.');
    const factor={mm:1/MM_PER_PX,cm:10/MM_PER_PX,in:96,pt:96/72,pc:16,px:1,q:.25/MM_PER_PX};
    return finite(number(match[1])*factor[match[2].toLowerCase()]);
  }
  return number(s);
}
function rootMatrix(a) {
  const vb=a.viewBox===undefined?null:numbers(a.viewBox);
  if(vb&&(vb.length!==4||vb[2]<=0||vb[3]<=0)) fail('Invalid SVG viewBox.');
  const w=a.width===undefined?(vb?vb[2]:300)*MM_PER_PX:lengthMM(a.width);
  const h=a.height===undefined?(vb?vb[3]:150)*MM_PER_PX:lengthMM(a.height);
  let m;
  if(!vb) m=[MM_PER_PX,0,0,MM_PER_PX,0,0];
  else {
    let sx=w/vb[2],sy=h/vb[3],dx=0,dy=0;
    const par=(a.preserveAspectRatio??'xMidYMid meet').trim();
    if(par!=='none') {
      const match=par.match(/^x(Min|Mid|Max)Y(Min|Mid|Max)(?:\s+(meet|slice))?$/);
      if(!match) fail('Unsupported preserveAspectRatio.');
      if(match[3]==='slice') fail('SVG slice/clipping is unsupported; use meet or none.');
      sx=sy=Math.min(sx,sy); const align={Min:0,Mid:.5,Max:1}; dx=(w-vb[2]*sx)*align[match[1]];dy=(h-vb[3]*sy)*align[match[2]];
    }
    m=[sx,0,0,sy,dx-vb[0]*sx,dy-vb[1]*sy];
  }
  // Reflect SVG's downwards Y axis about the viewport's bottom edge into model mm.
  return mul([1,0,0,-1,0,h],mul(m,transform(a.transform)));
}
const COMMON=new Set(['id','transform','fill','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-miterlimit','opacity','fill-opacity','stroke-opacity']);
const ATTRS={svg:['xmlns','version','width','height','viewBox','preserveAspectRatio'],g:[],path:['d'],polygon:['points'],polyline:['points'],rect:['x','y','width','height'],line:['x1','y1','x2','y2'],circle:['cx','cy','r'],ellipse:['cx','cy','rx','ry'],title:[],desc:[]};
function attributes(raw,tag) {
  const result=Object.create(null); let end=0;
  const re=/([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;
  for(const match of raw.matchAll(re)) {
    if(raw.slice(end,match.index).trim()) fail('Malformed SVG attributes.');
    const key=match[1],value=match[2].slice(1,-1);
    if(Object.hasOwn(result,key)) fail(`Duplicate SVG attribute: ${key}`);
    if(!COMMON.has(key)&&!ATTRS[tag].includes(key)) fail(`Unsupported SVG attribute: ${key}`);
    if(/url\s*\(|javascript:|data:|https?:|\/\//i.test(value)&&key!=='xmlns') fail('External references and paint servers are not allowed.');
    if(key==='xmlns'&&value!=='http://www.w3.org/2000/svg') fail('Only the SVG namespace is allowed.');
    if(key==='fill-rule'&&!['evenodd','nonzero'].includes(value)) fail('Invalid fill-rule.');
    if(['opacity','fill-opacity','stroke-opacity'].includes(key)&&number(value)!==1) fail('SVG transparency is unsupported; flatten or remove it first.');
    result[key]=value; end=match.index+match[0].length;
  }
  if(raw.slice(end).trim()) fail('Malformed SVG attributes.'); return result;
}
function distanceLine(p,a,b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy;
  const t=l?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/l)):0;
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
const midpoint=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
function cubic(p0,p1,p2,p3,tol,append,depth=0) {
  if(Math.max(distanceLine(p1,p0,p3),distanceLine(p2,p0,p3))<=tol) { append(p3); return; }
  if(depth>=16) fail('SVG curve exceeds flattening precision limits.');
  const a=midpoint(p0,p1),b=midpoint(p1,p2),c=midpoint(p2,p3),d=midpoint(a,b),e=midpoint(b,c),f=midpoint(d,e);
  cubic(p0,a,d,f,tol,append,depth+1); cubic(f,e,c,p3,tol,append,depth+1);
}
function parsePath(d,m,tol,consume) {
  if(typeof d!=='string'||!d.trim()) fail('SVG path is empty.');
  const tokens=[]; const re=/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g; let end=0;
  for(const match of d.matchAll(re)) { if(d.slice(end,match.index).replace(/[\s,]/g,'')) fail('Malformed SVG path data.'); tokens.push(match[0]); if(tokens.length>100000) fail('SVG path token limit exceeded.'); end=match.index+match[0].length; }
  if(d.slice(end).trim()) fail('Malformed SVG path data.');
  let i=0,cmd=null,cur=[0,0],start=null,p=[];
  const append=q=>{ if(!p.length||!equal(p.at(-1),q)) { consume(); p.push(q); if(p.length>MAX_PATH_POINTS) fail('SVG contour exceeds 4096 points; simplify the source.'); } };
  const paths=[];
  const flush=closed=>{ if(p.length) { if(closed&&p.length>1&&equal(p[0],p.at(-1)))p.pop(); if(p.length<(closed?3:2))fail('SVG path has degenerate geometry.'); paths.push({points:p,closed}); p=[]; } };
  const read=n=>{ if(i+n>tokens.length)fail('Incomplete SVG path command.'); const a=tokens.slice(i,i+n).map(x=>number(x)); i+=n; return a; };
  while(i<tokens.length) {
    if(/^[a-zA-Z]$/.test(tokens[i])) cmd=tokens[i++];
    if(!cmd||!/[MLHVQCZmlhvqcz]/.test(cmd)) fail(`Unsupported SVG path command: ${cmd??'missing moveto'}. Supported: M L H V C Q Z.`);
    const upper=cmd.toUpperCase(),rel=cmd!==upper;
    if(upper==='Z') { if(!start)fail('Closepath requires moveto.'); flush(true);cur=[...start];start=null;cmd=null;continue; }
    if(upper!=='M'&&!start) { if(paths.length&&cur) {start=[...cur];append(point(m,cur));} else fail('SVG path must start with moveto.'); }
    const a=read({M:2,L:2,H:1,V:1,C:6,Q:4}[upper]);
    const pos=(x,y)=>[finite(x+(rel?cur[0]:0)),finite(y+(rel?cur[1]:0))];
    if(upper==='M') { flush(false);cur=pos(a[0],a[1]);start=[...cur];append(point(m,cur));cmd=rel?'l':'L'; }
    else if(upper==='L') {cur=pos(a[0],a[1]);append(point(m,cur));}
    else if(upper==='H') {cur=[finite(a[0]+(rel?cur[0]:0)),cur[1]];append(point(m,cur));}
    else if(upper==='V') {cur=[cur[0],finite(a[0]+(rel?cur[1]:0))];append(point(m,cur));}
    else {
      const p0=point(m,cur); let p1,p2,p3,next;
      if(upper==='C') {p1=point(m,pos(a[0],a[1]));p2=point(m,pos(a[2],a[3]));next=pos(a[4],a[5]);p3=point(m,next);}
      else {const q=point(m,pos(a[0],a[1]));next=pos(a[2],a[3]);p3=point(m,next);p1=p0.map((v,k)=>v+2*(q[k]-v)/3);p2=p3.map((v,k)=>v+2*(q[k]-v)/3);}
      cubic(p0,p1,p2,p3,tol,append);cur=next;
    }
  }
  flush(false); return paths;
}
function inside(p,polygon) {
  let yes=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) {const a=polygon[i],b=polygon[j];if(((a[1]>p[1])!==(b[1]>p[1]))&&(p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]))yes=!yes;}
  return yes;
}
export function parseSVG(text, options={}) {
  if(typeof text!=='string'||text.length>2*1024*1024) fail('SVG must be text smaller than 2 MB.');
  if(/<!\s*(?:DOCTYPE|ENTITY)|<\?[^x]|&|<!\[CDATA\[/i.test(text)) fail('SVG declarations, entities, and CDATA are not allowed.');
  text=text.replace(/^\uFEFF/,'').replace(/^\s*<\?xml\s+[^?]*\?>/,'');
  const cfg=optionsFor(options),tol=options.tolerance??.1;
  if(!Number.isFinite(tol)||tol<.001||tol>10)fail('SVG tolerance must be 0.001–10 mm.');
  const maxPoints=options.maxPoints??MAX_POINTS;
  if(!Number.isInteger(maxPoints)||maxPoints<3||maxPoints>20000)fail('SVG point budget must be 3–20000.');
  let count=0,nodes=0,end=0,rootSeen=false,rootClosed=false; const stack=[],ops=[],warnings=[];
  const consume=()=>{if(++count>maxPoints)fail('SVG point budget exceeded; simplify the source.');};
  const tags=/<!--[\s\S]*?-->|<[^>]*>/g;
  for(const match of text.matchAll(tags)) {
    const between=text.slice(end,match.index); if(between.trim()&&!['title','desc'].includes(stack.at(-1)?.tag))fail('Unsupported SVG text content.'); end=match.index+match[0].length;
    const token=match[0]; if(token.startsWith('<!--'))continue;
    if(++nodes>10000)fail('SVG element limit exceeded.');
    if(token.startsWith('</')) {
      const close=token.match(/^<\/([a-zA-Z][\w:-]*)\s*>$/); if(!close||stack.at(-1)?.tag!==close[1])fail('Mismatched SVG tags.');
      if(stack.pop().tag==='svg')rootClosed=true; continue;
    }
    const open=token.match(/^<([a-zA-Z][\w:-]*)([\s\S]*?)(\/?)>$/);if(!open)fail('Unsupported XML syntax.');
    const tag=open[1]; if(!Object.hasOwn(ATTRS,tag))fail(`Unsupported SVG element: ${tag}`);
    if(rootClosed||(!rootSeen&&tag!=='svg')||(rootSeen&&tag==='svg'))fail('SVG must have one root; nested SVG viewports are unsupported.');
    if(stack.length&& !['svg','g'].includes(stack.at(-1).tag))fail('Geometry elements cannot contain child elements.');
    const a=attributes(open[2],tag),parent=stack.at(-1),m=tag==='svg'?rootMatrix(a):mul(parent?.m??IDENT,transform(a.transform));
    if(Math.abs(m[0]*m[3]-m[1]*m[2])<1e-12)fail('Combined SVG transform is too small or singular.');
    const fill=a.fill??parent?.fill??'black',rule=a['fill-rule']??parent?.rule??'nonzero';
    if(tag==='svg')rootSeen=true;
    if(!['svg','g','title','desc'].includes(tag)) {
      let paths=[];
      if(tag==='path')paths=parsePath(a.d,m,tol,consume);
      else {
        let p=[],closed=true; const n=(key,def=0)=>userLength(a[key],def);
        if(tag==='polygon'||tag==='polyline') {const v=numbers(a.points??'');if(v.length%2)fail('SVG points require x/y pairs.');for(let i=0;i<v.length;i+=2)p.push([v[i],v[i+1]]);closed=tag==='polygon';}
        if(tag==='rect') {const x=n('x'),y=n('y'),w=n('width'),h=n('height');if(w<=0||h<=0)fail('SVG rectangle dimensions must be positive.');p=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];}
        if(tag==='line'){p=[[n('x1'),n('y1')],[n('x2'),n('y2')]];closed=false;}
        if(tag==='circle'||tag==='ellipse') {
          const cx=n('cx'),cy=n('cy'),rx=tag==='circle'?n('r'):n('rx'),ry=tag==='circle'?rx:n('ry');if(rx<=0||ry<=0)fail('SVG radii must be positive.');
          const radius=Math.max(rx,ry)*Math.hypot(...m.slice(0,4)),segments=Math.max(12,Math.ceil(Math.PI/Math.acos(Math.max(-1,1-tol/radius))));
          if(!Number.isFinite(segments)||segments>MAX_PATH_POINTS)fail('SVG ellipse exceeds point budget.');
          p=Array.from({length:segments},(_,i)=>[cx+rx*Math.cos(i*2*Math.PI/segments),cy+ry*Math.sin(i*2*Math.PI/segments)]);
        }
        if(p.length>1&&equal(p[0],p.at(-1)))p.pop();
        if(p.length<(closed?3:2)||p.length>MAX_PATH_POINTS)fail('SVG geometry has too few or too many points.');
        paths=[{points:p.map(v=>{consume();return point(m,v);}),closed}];
      }
      const closed=paths.filter(p=>p.closed);
      if(a.id && /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\uFFFE\uFFFF]/u.test(a.id))fail('SVG identifier contains unsupported control characters.');
      for(const p of paths) {
        let hole=false;
        if(p.closed&&fill!=='none') {
          const containers=closed.filter(q=>q!==p&&Math.abs(area(q.points))>Math.abs(area(p.points))&&inside(p.points[0],q.points));
          if(rule==='evenodd')hole=containers.length%2===1;
          else if(containers.length) {const winding=containers.reduce((n,q)=>n+Math.sign(area(q.points)),0);hole=winding!==0&&winding+Math.sign(area(p.points))===0;}
        }
        if(p.closed&&Math.abs(area(p.points))<1e-12)fail('SVG contains a zero-area closed contour.');
        ops.push({op:'path',...p,...cfg,hole,name:(a.id||`SVG ${tag}`).slice(0,120)});
        if(ops.length>1000)fail('SVG contour limit exceeded.');
      }
    }
    if(!open[3]) {stack.push({tag,m,fill,rule});if(stack.length>32)fail('SVG nesting limit exceeded.');} else if(tag==='svg')rootClosed=true;
  }
  if(text.slice(end).trim()||stack.length||!rootSeen||!rootClosed)fail('Incomplete or malformed SVG.');
  if(!ops.length)fail('SVG contains no supported geometry.');
  warnings.push('Imported geometry only. Stroke widths are not expanded, text is not traced, and dimensions must be checked before cutting.');
  return {ops,warnings,bounds:boundsOf(ops)};
}

function rasterMask(image,options) {
  const {width:w,height:h,data}=image??{};
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||Math.max(w,h)>1024||!data||data.length!==w*h*4)fail('Trace input must be RGBA, 1–1024 pixels per side.');
  if(options.invert!==undefined && typeof options.invert!=='boolean')fail('Inversion must be a boolean.');
  const threshold=options.threshold??128;
  if(!Number.isFinite(threshold)||threshold<0||threshold>255)fail('Threshold must be 0–255.');
  const mode=options.thresholdMode??'global';if(!['global','adaptive'].includes(mode))fail('Unknown threshold mode.');
  const gray=new Uint8Array(w*h),mask=new Uint8Array(w*h);
  for(let i=0;i<gray.length;i++) {
    const k=i*4,a=data[k+3]/255;
    if(!Number.isFinite(a)||a<0||a>1)fail('Invalid RGBA values.');
    const lum=.2126*data[k]+.7152*data[k+1]+.0722*data[k+2];
    if(!Number.isFinite(lum)||lum<0||lum>255.001)fail('Invalid RGBA values.');
    // Transparency is always background, even for inverted white-on-black drawings.
    gray[i]=Math.round((options.invert?255-lum:lum)*a+255*(1-a));
  }
  let integral;
  if(mode==='adaptive') {
    integral=new Float64Array((w+1)*(h+1));
    for(let y=0;y<h;y++) {let sum=0;for(let x=0;x<w;x++){sum+=gray[y*w+x];integral[(y+1)*(w+1)+x+1]=integral[y*(w+1)+x+1]+sum;}}
  }
  const window=options.adaptiveWindow??31,offset=options.adaptiveOffset??10;
  if(!Number.isInteger(window)||window<3||window>255||!Number.isFinite(offset)||offset<0||offset>128)fail('Invalid adaptive threshold settings.');
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    let t=threshold;
    if(integral) {
      const r=Math.floor(window/2),x0=Math.max(0,x-r),x1=Math.min(w,x+r+1),y0=Math.max(0,y-r),y1=Math.min(h,y+r+1),s=w+1;
      t=(integral[y1*s+x1]-integral[y0*s+x1]-integral[y1*s+x0]+integral[y0*s+x0])/((x1-x0)*(y1-y0))-offset;
    }
    mask[y*w+x]=gray[y*w+x]<t?1:0;
  }
  return mask;
}
function removeSmallComponents(mask,w,h,minArea) {
  const seen=new Uint8Array(mask.length),queue=new Int32Array(mask.length);let removed=0;
  for(let start=0;start<mask.length;start++) {
    if(!mask[start]||seen[start])continue;
    let head=0,tail=1;queue[0]=start;seen[start]=1;
    while(head<tail) {
      const p=queue[head++],x=p%w,y=Math.floor(p/w);
      for(const q of [x>0?p-1:-1,x+1<w?p+1:-1,y>0?p-w:-1,y+1<h?p+w:-1])if(q>=0&&mask[q]&&!seen[q]){seen[q]=1;queue[tail++]=q;}
    }
    if(tail<minArea) {removed+=tail;for(let j=0;j<tail;j++)mask[queue[j]]=0;}
  }
  return removed;
}
function cleanMask(mask,w,h,passes) {
  // Optional 3x3 majority cleanup. Off by default: it can erase narrow pen strokes.
  for(let pass=0;pass<passes;pass++) {
    const next=mask.slice();
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h)n+=mask[(y+dy)*w+x+dx];
      next[y*w+x]=n>=5?1:0;
    }
    mask=next;
  }
  return mask;
}
function collinear(points) {
  return points.filter((b,i)=>{
    const a=points[(i+points.length-1)%points.length],c=points[(i+1)%points.length];
    return (b[0]-a[0])*(c[1]-b[1])!==(b[1]-a[1])*(c[0]-b[0]);
  });
}
function rdp(points,tol,budget) {
  const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;const stack=[[0,points.length-1]];
  while(stack.length) {
    const [a,b]=stack.pop();let best=tol,index=-1;
    for(let i=a+1;i<b;i++){if(++budget.work>2000000)fail('Trace simplification exceeds work budget. Reduce image size.');const d=distanceLine(points[i],points[a],points[b]);if(d>best){best=d;index=i;}}
    if(index>=0){keep[index]=1;stack.push([a,index],[index,b]);}
  }
  return points.filter((_,i)=>keep[i]);
}
function simplifyClosed(points,tol,budget) {
  points=collinear(points);if(!tol||points.length<5)return points;
  // Under half a source pixel prevents crossing another grid boundary. Do not sacrifice topology for smoothness.
  tol=Math.min(tol,.49);
  let far=1,dist=0;for(let i=1;i<points.length;i++){const d=Math.hypot(points[i][0]-points[0][0],points[i][1]-points[0][1]);if(d>dist){far=i;dist=d;}}
  const p=rdp(points.slice(0,far+1),tol,budget).slice(0,-1).concat(rdp(points.slice(far).concat([points[0]]),tol,budget).slice(0,-1));
  const before=area(points),after=area(p);
  return p.length>=3&&Math.sign(before)===Math.sign(after)&&Math.abs(after/before)>=.8&&Math.abs(after/before)<=1.2?p:points;
}
/** Trace filled pixels' boundaries, not stroke centerlines. Hole contours retain their own geometry. */
export function traceRaster(image,options={}) {
  const cfg=optionsFor(options),w=image?.width,h=image?.height;
  let mask=rasterMask(image,options);
  const minArea=options.minArea??4,cleanup=options.cleanup??0,simplify=options.simplify??.5,scale=options.mmPerPixel??1;
  if(!Number.isInteger(minArea)||minArea<0||minArea>1048576)fail('Minimum area must be a nonnegative pixel count.');
  if(!Number.isInteger(cleanup)||cleanup<0||cleanup>2)fail('Cleanup must be 0, 1, or 2 passes.');
  if(!Number.isFinite(simplify)||simplify<0||simplify>20)fail('Simplification must be 0–20 pixels.');
  if(!Number.isFinite(scale)||scale<=0||scale>1000)fail('Trace mmPerPixel must be positive and at most 1000.');
  const warnings=['Silhouette outlines only, not centerlines. Thick strokes may create two cut boundaries; inspect holes and choose cut/engrave before fabrication.'];
  if(cleanup){mask=cleanMask(mask,w,h,cleanup);warnings.push('Background cleanup can remove thin strokes and small holes. Compare with the retained image.');}
  const removedPixels=removeSmallComponents(mask,w,h,minArea);
  if(removedPixels)warnings.push(`Removed ${removedPixels} foreground pixels in components smaller than ${minArea} pixels.`);
  if(simplify>.49)warnings.push('Simplification is limited to 0.49 source pixels to preserve separate contours and thin strokes.');
  const edges=new Map(),stride=w+1;let edgeCount=0,foregroundPixels=0;
  const edge=(x,y,dir)=>{const id=y*stride+x;edges.set(id,(edges.get(id)||0)|(1<<dir));if(++edgeCount>100000)fail('Trace is too complex (over 100000 boundary edges). Reduce noise or image size.');};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x]) {
    foregroundPixels++;
    if(y===0||!mask[(y-1)*w+x])edge(x,y,0);
    if(x===w-1||!mask[y*w+x+1])edge(x+1,y,1);
    if(y===h-1||!mask[(y+1)*w+x])edge(x+1,y+1,2);
    if(x===0||!mask[y*w+x-1])edge(x,y+1,3);
  }
  const junctions=new Set([...edges].filter(([,bits])=>(bits&(bits-1))!==0).map(([id])=>id));
  const ops=[],budget={work:0};let total=0,walked=0;
  const steps=[1,stride,-1,-stride];
  for(const [initial] of edges)while(edges.get(initial)) {
    let vertex=initial,dir=[0,1,2,3].find(d=>edges.get(vertex)&(1<<d)); const points=[];let touchesJunction=false;
    do {
      if(junctions.has(vertex))touchesJunction=true;
      if(++walked>edgeCount)fail('Trace boundary traversal exceeded its budget.');
      points.push([vertex%stride,Math.floor(vertex/stride)]);
      edges.set(vertex,edges.get(vertex)&~(1<<dir));vertex+=steps[dir];
      if(vertex===initial)break;
      const bits=edges.get(vertex)||0;
      dir=[(dir+1)%4,dir,(dir+3)%4,(dir+2)%4].find(d=>bits&(1<<d));
      if(dir===undefined)fail('Trace boundary is not closed.');
    }while(true);
    const hole=area(points)<0,p=simplifyClosed(points,touchesJunction?0:simplify,budget);
    if(p.length>MAX_PATH_POINTS)fail('A trace contour exceeds 4096 points. Reduce noise or image size.');
    if((total+=p.length)>MAX_POINTS)fail('Trace exceeds 12000 points. Reduce noise or image size.');
    if(ops.length>=1000)fail('Trace contains too many separate contours. Increase minimum area.');
    ops.push({op:'path',points:p.map(([x,y])=>[x*scale,(h-y)*scale]),closed:true,...cfg,hole,name:hole?'Trace hole':'Trace outline'});
  }
  if(!ops.length)warnings.push('No foreground survived these settings. Adjust threshold, inversion, or minimum area.');
  return {ops,warnings,bounds:boundsOf(ops),width:w,height:h,foregroundPixels,removedPixels};
}

/** Inspect dimensions before asking the browser to decode any uploaded image. */
export function inspectRaster(input) {
  const b=input instanceof Uint8Array?input:input instanceof ArrayBuffer?new Uint8Array(input):null;
  if(!b||b.length<24||b.length>MAX_BYTES)fail('Image must be a PNG or JPEG smaller than 10 MB.');
  const u32=i=>b[i]*16777216+b[i+1]*65536+b[i+2]*256+b[i+3];
  let width,height,mime;
  if([137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v)) {
    if(u32(8)!==13||String.fromCharCode(...b.slice(12,16))!=='IHDR')fail('Invalid PNG header.');
    width=u32(16);height=u32(20);mime='image/png';
  } else if(b[0]===255&&b[1]===216) {
    let i=2;mime='image/jpeg';
    while(i<b.length) {
      if(b[i++]!==255)fail('Invalid JPEG marker.');while(b[i]===255)i++;
      const marker=b[i++];if(marker===0xda||marker===0xd9)break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(i+2>b.length)fail('Truncated JPEG header.');const length=b[i]*256+b[i+1];if(length<2||i+length>b.length)fail('Truncated JPEG segment.');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if(length<8)fail('Invalid JPEG frame.');height=b[i+3]*256+b[i+4];width=b[i+5]*256+b[i+6];break;
      }
      i+=length;
    }
  } else fail('Only genuine PNG and JPEG files are supported. SVG must use the vector importer.');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384||width*height>32000000)fail('Image dimensions exceed the safe 32 megapixel / 16384 pixel decode limit.');
  return {width,height,mime};
}
/** Browser-only decode. The retained underlay is a sanitized, bounded PNG, never original executable content. */
export async function loadRasterFile(file,{maxDimension=1024}={}) {
  if(!file||typeof file.arrayBuffer!=='function'||!Number.isFinite(file.size)||file.size>MAX_BYTES)fail('Image must be a PNG or JPEG smaller than 10 MB.');
  if(!Number.isInteger(maxDimension)||maxDimension<1||maxDimension>1024)fail('Trace size must be 1–1024 pixels.');
  const bytes=new Uint8Array(await file.arrayBuffer()),meta=inspectRaster(bytes);
  if(typeof createImageBitmap!=='function'||typeof document==='undefined')fail('Image decoding requires a browser with createImageBitmap support.');
  const bitmap=await createImageBitmap(new Blob([bytes],{type:meta.mime}));
  try {
    if(bitmap.width*bitmap.height>32000000||Math.max(bitmap.width,bitmap.height)>16384)fail('Decoded image exceeds safe dimensions.');
    const ratio=Math.min(1,maxDimension/Math.max(bitmap.width,bitmap.height)),width=Math.max(1,Math.round(bitmap.width*ratio)),height=Math.max(1,Math.round(bitmap.height*ratio));
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)fail('Canvas is unavailable.');
    ctx.drawImage(bitmap,0,0,width,height);
    const imageData=ctx.getImageData(0,0,width,height),sourceURL=canvas.toDataURL('image/png');
    return {imageData,width,height,originalWidth:bitmap.width,originalHeight:bitmap.height,sourceURL,dataURL:sourceURL,dispose(){canvas.width=canvas.height=0;}};
  } finally {bitmap.close();}
}
