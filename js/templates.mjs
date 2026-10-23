// Curated, editable millimetre geometry. World coordinates are y-up.
// These are explicit design recipes, not arbitrary prompt-to-pattern generation.
const tr = (en, zh) => ({ en, zh });
const param = (key, en, zh, value, min, max, step = 1, unit = 'mm') =>
  ({ key, label: tr(en, zh), default: value, min, max, step, unit });
const catalog = [
  { id: 'tshirt', kind: 'illustration', title: tr('T-shirt flat', 'T 恤平面图'),
    description: tr('Recognizable front-view garment outline. Illustration, not sewing pieces.', '可编辑的 T 恤正面轮廓。仅作示意，不是可缝制纸样。'),
    parameters: [param('bodyWidth', 'Body width', '衣身宽度', 520, 200, 900), param('bodyLength', 'Body length', '衣身长度', 680, 300, 1200), param('sleeveLength', 'Sleeve projection', '袖子横向长度', 180, 60, 400)] },
  { id: 'dress', kind: 'illustration', title: tr('A-line dress flat', 'A 字连衣裙平面图'),
    description: tr('Sleeveless A-line silhouette with neckline and waist reference. Not a fitted pattern.', '含领口与腰线的无袖 A 字裙轮廓。不是合体裁剪纸样。'),
    parameters: [param('bustWidth', 'Bust width', '胸部平铺宽度', 460, 200, 800), param('waistWidth', 'Waist width', '腰部平铺宽度', 360, 160, 700), param('hemWidth', 'Hem width', '裙摆宽度', 780, 300, 1400), param('length', 'Dress length', '裙长', 1000, 450, 1600)] },
  { id: 'house', kind: 'illustration', title: tr('House silhouette', '房屋轮廓'),
    description: tr('One connected house outline with separate engraved door and window details.', '完整房屋外轮廓，门窗细节位于独立雕刻图层。'),
    parameters: [param('width', 'House width', '房屋宽度', 160, 30, 1000), param('height', 'Wall height', '墙面高度', 100, 30, 1000), param('roofHeight', 'Roof height', '屋顶高度', 65, 15, 500)] },
  { id: 'keytag', kind: 'illustration', title: tr('Rounded key tag', '圆角钥匙牌'),
    description: tr('Rounded outline and a separate closed key-ring hole. Check material and kerf before cutting.', '圆角外轮廓与独立封闭钥匙孔。切割前检查材料与切缝。'),
    parameters: [param('width', 'Tag width', '牌宽', 70, 30, 200), param('height', 'Tag height', '牌高', 30, 15, 100), param('holeDiameter', 'Ring-hole diameter', '挂环孔直径', 5, 2, 12, 0.5)] },
  { id: 'apron', kind: 'pattern', title: tr('Measurement-driven apron DRAFT', '按尺寸生成的围裙初稿'),
    description: tr('Original straight-sided, lined bib-apron draft with true seam offsets and separate straps. Untested fit.', '原创直边双层围裙初稿，包含真实等距缝份与独立带片。未经试穿验证。'),
    parameters: [param('bodyWidth', 'Finished body width', '成品衣身宽度', 650, 350, 1000), param('bodyLength', 'Finished body length', '成品衣身长度', 800, 450, 1200), param('bibWidth', 'Finished bib width', '成品胸片宽度', 260, 140, 500), param('bibHeight', 'Bib height above waist', '腰线上胸片高度', 260, 150, 450), param('waist', 'Waist circumference', '腰围', 900, 500, 1600), param('ease', 'Waist tying ease', '腰带松量', 40, 0, 150), param('tieTail', 'Extra length per tie for bow', '每侧系结预留长度', 350, 200, 600), param('strapWidth', 'Finished strap / tie width', '成品肩带及腰带宽', 30, 20, 60), param('neckStrapLength', 'Finished neck strap length', '成品颈带长度', 600, 350, 900), param('seamAllowance', 'Uniform seam allowance', '统一缝份', 10, 0, 25, 0.5)] }
];

/** Fresh metadata, safe for an editable parameter UI. Numeric values are mm. */
export function listTemplates() { return structuredClone(catalog); }

function readParams(def, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Template parameters must be an object');
  const keys = new Set(def.parameters.map(p => p.key));
  for (const key of Object.keys(input)) if (!keys.has(key)) throw Error(`Unknown ${def.id} parameter: ${key}`);
  return Object.fromEntries(def.parameters.map(p => {
    const raw = input[p.key] === undefined ? p.default : input[p.key];
    if ((typeof raw !== 'number' && typeof raw !== 'string') || (typeof raw === 'string' && !raw.trim())) throw Error(`${p.key} must be a finite number`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < p.min || n > p.max) throw Error(`${p.key} must be between ${p.min} and ${p.max}`);
    return [p.key, n];
  }));
}
const path = (points, name, group, layer = 'cut', closed = true, hole = false) => ({ op: 'path', points, closed, layer, group, hole, name });
const line = (from, to, name, group, layer = 'reference') => ({ op: 'line', from, to, layer, group, name });
const label = (at, text, group, size = 8) => ({ op: 'text', at, text, size, layer: 'reference', group, name: text });
const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const translate = (points, x, y) => points.map(([a, b]) => [a + x, b + y]);
const area = points => points.reduce((s, p, i) => { const q = points[(i + 1) % points.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

// Exact intersection of adjacent parallel-offset lines, not centroid scaling.
// This deliberately supports only convex, CCW template polygons. Never applied
// to imported drawings. Bounds / cross-parameter checks keep mitres well behaved.
function offsetConvex(points, distance) {
  if (!distance) return points.map(p => [...p]);
  if (!(area(points) > 0)) throw Error('Offset requires counterclockwise points');
  const edges = points.map((p, i) => {
    const q = points[(i + 1) % points.length], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    if (!len) throw Error('Offset cannot contain zero-length edges');
    return { p: [p[0] + dy / len * distance, p[1] - dx / len * distance], d: [dx, dy] };
  });
  return edges.map((b, i) => {
    const a = edges[(i + edges.length - 1) % edges.length];
    const det = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (det <= 1e-9) throw Error('Offset requires strictly convex corners');
    const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
    const t = (dx * b.d[1] - dy * b.d[0]) / det;
    return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
  });
}
function neckline(width, top, depth, steps = 16) {
  // A sampled lower half ellipse, from right shoulder inward to left shoulder.
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = Math.PI * i / steps;
    return [width / 2 * Math.cos(t), top - depth * Math.sin(t)];
  });
}
function grainline(ops, x, bottom, top, group) {
  ops.push(line([x, bottom], [x, top], 'Grainline', group));
  const a = Math.min(8, (top - bottom) / 8);
  for (const [y, s] of [[bottom, 1], [top, -1]]) {
    ops.push(path([[x - a / 2, y + s * a], [x, y], [x + a / 2, y + s * a]], 'Grainline arrow', group, 'reference', false));
  }
}
function rectanglePiece(ops, { x, y, width, length, sa, name, group }) {
  const seam = rectangle(x, y, width, length);
  ops.push(path(offsetConvex(seam, sa), `${name} cutline`, group));
  ops.push(path(seam, `${name} seamline`, group, 'reference'));
  ops.push(line([x + width / 2, y], [x + width / 2, y + length], `${name} foldline`, group));
  grainline(ops, x + width / 4, y + length * 0.2, y + length * 0.8, group);
  ops.push(label([x, y + length + sa + 12], name, group, 6));
}

export function generateTemplate(id, params = {}) {
  const def = catalog.find(t => t.id === id);
  if (!def) throw Error(`Unknown template: ${String(id)}`);
  const p = readParams(def, params), ops = [], warnings = [], notes = [], dimensions = { ...p };
  if (def.kind === 'illustration' && (id === 'tshirt' || id === 'dress')) warnings.push(tr('GARMENT FLAT ONLY: this is not a sewing pattern and has no verified fit, seam allowance or construction pieces.', '仅服装平面示意：不是缝纫纸样，未验证合体性，不含缝份或完整裁片。'));
  if (id === 'tshirt') {
    const w = p.bodyWidth, h = p.bodyLength, s = p.sleeveLength, group = 'tshirt-flat';
    const points = [[-w / 2, 0], [w / 2, 0], [w / 2, h * 0.60], [w / 2 + s, h * 0.69], [w / 2 + s, h * 0.89], [w * 0.39, h], ...neckline(w * 0.34, h, h * 0.09), [-w * 0.39, h], [-w / 2 - s, h * 0.89], [-w / 2 - s, h * 0.69], [-w / 2, h * 0.60]];
    ops.push(path(points, 'T-shirt front silhouette', group));
    ops.push(line([-w / 2, h * 0.035], [w / 2, h * 0.035], 'Hem detail', group));
    ops.push(label([-w / 2, -30], 'T-SHIRT FLAT / NOT A SEWING PATTERN', group));
    dimensions.overallWidth = w + 2 * s; dimensions.overallHeight = h;
  } else if (id === 'dress') {
    const b = p.bustWidth, w = p.waistWidth, hem = p.hemWidth, h = p.length, group = 'dress-flat';
    if (w >= b) throw Error('waistWidth must be smaller than bustWidth for this A-line design');
    if (hem <= w) throw Error('hemWidth must exceed waistWidth for this A-line design');
    const points = [[-hem / 2, 0], [hem / 2, 0], [w / 2, h * 0.56], [b / 2, h * 0.80], [b * 0.34, h * 0.90], [b * 0.32, h], ...neckline(b * 0.35, h, h * 0.065), [-b * 0.32, h], [-b * 0.34, h * 0.90], [-b / 2, h * 0.80], [-w / 2, h * 0.56]];
    ops.push(path(points, 'Sleeveless A-line dress silhouette', group));
    ops.push(line([-w / 2, h * 0.56], [w / 2, h * 0.56], 'Waist reference', group));
    ops.push(label([-hem / 2, -30], 'DRESS FLAT / NOT A SEWING PATTERN', group));
    dimensions.overallWidth = Math.max(hem, b); dimensions.overallHeight = h;
  } else if (id === 'house') {
    const w = p.width, h = p.height, r = p.roofHeight, group = 'house';
    ops.push(path([[0, 0], [w, 0], [w, h], [w / 2, h + r], [0, h]], 'House outline', group));
    ops.push(path([[w * .4, 0], [w * .4, h * .58], [w * .6, h * .58], [w * .6, 0]], 'Door engraving', group, 'engrave', false));
    for (const x of [w * .12, w * .70]) {
      ops.push(path(rectangle(x, h * .45, w * .18, h * .26), 'Window engraving', group, 'engrave'));
      ops.push(line([x + w * .09, h * .45], [x + w * .09, h * .71], 'Window mullion', group, 'engrave'));
    }
    dimensions.overallWidth = w; dimensions.overallHeight = h + r;
    notes.push(tr('Door and windows are engraving details, not loose cut-out pieces.', '门窗为雕刻细节，不是会脱落的镂空裁片。'));
  } else if (id === 'keytag') {
    const w = p.width, h = p.height, hole = p.holeDiameter, r = Math.min(w, h) * .18, group = 'keytag';
    if (hole > h * .4) throw Error('holeDiameter must not exceed 40% of height');
    const points = [];
    for (const [cx, cy, start] of [[w-r, r, -90], [w-r, h-r, 0], [r, h-r, 90], [r, r, 180]]) {
      for (let i = 0; i <= 8; i++) { const a = (start + 90 * i / 8) * Math.PI / 180; points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    }
    ops.push(path(points, 'Rounded key tag outline', group));
    ops.push(path(Array.from({ length: 48 }, (_, i) => { const a = -i * Math.PI * 2 / 48; return [Math.min(w, h) * .3 + hole / 2 * Math.cos(a), h / 2 + hole / 2 * Math.sin(a)]; }), 'Key-ring hole', group, 'cut', true, true));
    ops.push(label([Math.min(w, h) * .55, h * .42], 'KEY TAG', group, Math.min(5, h * .15)));
    dimensions.overallWidth = w; dimensions.overallHeight = h;
    warnings.push(tr('Nominal geometry only. No kerf or material-strength allowance has been applied.', '仅名义尺寸，未补偿切缝或材料强度。'));
  } else if (id === 'apron') {
    const {bodyWidth:w, bodyLength:h, bibWidth:b, bibHeight:bh, seamAllowance:sa, strapWidth:sw} = p;
    if (b > w - 80) throw Error('bibWidth must be at least 80 mm narrower than bodyWidth');
    if (b < 2 * sw + 40) throw Error('bibWidth must allow both straps plus 40 mm clearance');
    if (bh > h - 200) throw Error('bibHeight must leave at least 200 mm of body below the waist');
    const waistY = h - bh, group = 'apron-body';
    const seam = [[0, 0], [w, 0], [w, waistY], [(w+b)/2, h], [(w-b)/2, h], [0, waistY]];
    const cut = offsetConvex(seam, sa);
    ops.push(path(cut, 'Apron body cutline - CUT 2 mirrored fabrics', group));
    ops.push(path(seam, 'Apron body finished seamline', group, 'reference'));
    grainline(ops, w / 2, h * .17, h * .79, group);
    ops.push(label([30, h * .33], 'APRON BODY: CUT 2 (outer + lining)', group));
    ops.push(label([30, h * .29], 'DRAFT / UNTESTED FIT / mm', group));
    ops.push(label([30, h * .25], `Seam allowance ${sa} mm; straight grain`, group));
    ops.push(line([0, waistY], [w, waistY], 'Waist / tie attachment reference', group));
    // Non-cut placement ticks avoid accidental slits. Ties lie below waist;
    // neck strap attachments sit inside each upper bib corner.
    for (const x of [0, w]) {
      const dir = x === 0 ? 1 : -1;
      for (const y of [waistY, waistY - sw]) ops.push(line([x, y], [x + dir * 8, y], 'Waist tie placement notch - mark only', group));
    }
    for (const x of [(w-b)/2 + 15, (w+b)/2 - 15 - sw]) {
      for (const xx of [x, x+sw]) ops.push(line([xx, h], [xx, h-8], 'Neck strap placement notch - mark only', group));
    }
    // Finished body width is explicit, NOT inferred from clothing size.
    // Ties bridge the uncovered eased waist plus a separately editable bow tail.
    const tieLength = Math.max(0, (p.waist + p.ease - w) / 2) + p.tieTail;
    const pitch = 2 * sw + 2 * sa + 45, x0 = w + sa + 50;
    rectanglePiece(ops, { x:x0, y:0, width:2*sw, length:p.neckStrapLength, sa, name:'NECK STRAP - CUT 1', group:'apron-neck' });
    for (let i=0;i<2;i++) rectanglePiece(ops, { x:x0+(i+1)*pitch, y:0, width:2*sw, length:tieLength, sa, name:`WAIST TIE ${i+1} - CUT 1`, group:`apron-tie-${i+1}` });
    const squareX = x0, squareY = Math.max(p.neckStrapLength, tieLength) + sa + 70;
    ops.push(path(rectangle(squareX, squareY, 50, 50), '50 mm calibration square - DO NOT CUT', 'apron-calibration', 'reference'));
    ops.push(label([squareX, squareY+62], '50 x 50 mm / print at 100%', 'apron-calibration', 6));
    Object.assign(dimensions, {finishedBodyWidth:w, finishedBodyLength:h, waistLineHeight:waistY, finishedTieLength:tieLength, strapOpenWidth:2*sw, strapCutWidth:2*sw+2*sa, neckCutLength:p.neckStrapLength+2*sa, tieCutLength:tieLength+2*sa, bodyCutWidth:w+2*sa, bodyCutHeight:h+2*sa});
    warnings.push(tr('DRAFT, UNTESTED FIT. Original geometric apron recipe, not a graded or professionally validated pattern. Make a toile and check coverage, neck length and tie reach before cutting final fabric.', '初稿，未经试穿验证。这是原创几何围裙构造，不是经放码或专业验证的纸样。先做坯布试样，检查覆盖范围、颈带长度和腰带长度，再裁正式面料。'));
    warnings.push(tr('Full-scale millimetres. Print/export at 100% and measure the 50 mm square. Reference labels, grainlines and notches must not be sent to a cutter.', '单位为毫米、实物比例。按 100% 输出并测量 50 毫米校准方框。文字、布纹线和对位标记不可发送至切割机。'));
    if (sa === 0) warnings.push(tr('Seam allowance is zero: cut and seam lines coincide. Add the allowance required by your construction before sewing.', '缝份为零：裁剪线与缝合线重合。缝制前请按工艺添加所需缝份。'));
    if (w > p.waist+p.ease) warnings.push(tr('Body width exceeds the eased waist circumference. Expect overlap; verify body coverage and tie placement in a toile.', '衣身宽度超过含松量的腰围，可能重叠。请以坯布试样确认覆盖范围及腰带位置。'));
    notes.push(tr(`Finished body ${w} x ${h} mm; bib ${b} mm wide and ${bh} mm above waist. Body width is your chosen coverage, not an automatic body-size conversion.`, `成品衣身 ${w} × ${h} 毫米；胸片宽 ${b} 毫米、腰线上高 ${bh} 毫米。衣身宽度由你选择，不是由人体尺码自动换算。`));
    notes.push(tr(`Each finished tie = max(0, (waist ${p.waist} + ease ${p.ease} - body width ${w}) / 2) + bow tail ${p.tieTail} = ${tieLength} mm. Ease affects tie reach only, not body width.`, `每侧成品腰带 = max(0, (腰围 ${p.waist} + 松量 ${p.ease} - 衣身宽 ${w}) / 2) + 系结余量 ${p.tieTail} = ${tieLength} 毫米。松量仅影响腰带长度，不改变衣身宽度。`));
    notes.push(tr(`Uniform ${sa} mm allowance is a parallel-edge offset with mitred corners, not scaling. Cut body twice (outer and lining); cut one neck strap and both ties. Straight sloping arm edges are intentional.`, `统一 ${sa} 毫米缝份由边线平行偏移与斜接交点生成，不是整体缩放。衣身裁两片（面布和里布），颈带一片，腰带各一片。胸片两侧特意采用直斜边。`));
    notes.push(tr('Strap rectangles are twice the finished width plus seam allowance. Fold lengthwise, stitch and turn; short ends are caught in the body seam. Mark attachment ticks, baste straps inward, sew body outer and lining right sides together, leave a turning gap, turn and close. This is a construction outline, not a tested sewing tutorial.', '带片宽度为成品宽的两倍加缝份。沿纵向折叠、缝合并翻面；短端夹缝进衣身。标记对位点，将带子向内疏缝固定，面里正面相对缝合、留返口、翻面并封口。以上仅为构造概述，不是经验证的缝制教程。'));
  }
  notes.push(tr('Curated editable geometry. Use image/SVG import and tracing for character artwork or designs outside these recipes.', '这是精选的可编辑几何模板。人物图稿或模板范围外的设计请使用图像／SVG 导入与描摹。'));
  return { ops, warnings, notes, dimensions, name: { ...def.title } };
}
