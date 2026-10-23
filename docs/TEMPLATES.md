# Curated templates and apron draft

`js/templates.mjs` contains five original, deterministic design recipes. It has no runtime dependency, network request, paid service, or arbitrary prompt-based generation. It does **not** replace importing/tracing a drawing, especially character artwork. Units are millimetres and world coordinates are y-up.

## API

- `listTemplates()` returns fresh definitions with `id`, `kind`, bilingual `{en, zh}` `title` and `description`, and `parameters`. A parameter contains `key`, bilingual `label`, numeric `default`, `min`, `max`, `step` and `unit`.
- `generateTemplate(id, params = {})` returns `ops`, bilingual `warnings` and `notes`, numeric `dimensions`, and a bilingual `name`. The supplied parameter object is not mutated. Missing values take defaults; invalid numbers, unknown parameters and incompatible proportions throw useful errors. Numeric strings from form controls are accepted; values are not silently clamped.
- Closed outline operations use `{op:'path', points:[[x,y],...], closed:true, layer, group, hole, name}`. The final point is not repeated. Closure is explicit.
- Text is always `reference`, never a cut contour. Meaningful group IDs identify pieces, not instance IDs. The caller may prefix groups when inserting multiple instances.

IDs are `tshirt`, `dress`, `house`, `keytag`, and `apron`.

## What each recipe means

**T-shirt and dress:** front-view flat illustrations only. Their necklines are sampled half ellipses. They are recognizable editable outlines, not garment blocks, graded sizes, fitted patterns, or complete sets of sewing pieces. They deliberately carry a warning and an on-canvas label saying so.

**House:** one connected cut boundary. The door and windows are separate engraving details; they do not create detached islands or cut-outs.

**Key tag:** a rounded cut boundary and a clockwise, separately flagged hole contour. The outline is counterclockwise. Circle/corner sampling is fixed and bounded. Nominal dimensions have no kerf or material-strength compensation. Verify the actual hole with a test cut for the chosen material.

**Apron:** an original, limited straight-sided **lined** bib-apron draft. It is not a FreeSewing Albert implementation, a copied commercial pattern, or a professionally validated pattern. There is no claim of automatic reliable clothing fit. It deliberately avoids pretending a garment illustration is a sewing pattern.

## Apron formulas and construction choice

The finished body is an explicit coverage rectangle with sloping upper corners:

- `W = bodyWidth`: desired finished horizontal coverage, supplied directly by the user.
- `H = bodyLength`: finished height from bottom hem seam to top bib seam.
- `B = bibWidth`: finished top bib width.
- `BH = bibHeight`: height of bib above the waist attachment level.
- `Ywaist = H - BH`.
- CCW finished seamline vertices: `(0,0)`, `(W,0)`, `(W,Ywaist)`, `((W+B)/2,H)`, `((W-B)/2,H)`, `(0,Ywaist)`.

These are intentional straight, sloping arm edges, not a fitted curved armscye. The body is symmetric and is cut **twice**, once in outer fabric and once in lining. It is assembled right sides together and turned. Thus a **uniform seam allowance** is coherent; this design does not claim the same allowance also makes double-fold hems. The user should check placement/coverage and construction in a toile.

The body width is not secretly derived from a dress size or a waist circumference. It is a direct design/coverage choice. Each waist tie has finished length:

`max(0, (waist + ease - bodyWidth) / 2) + tieTail`

Here `waist` is the waist circumference, `ease` is the additional tying circumference, and `tieTail` is an explicit per-side bow/knot reserve. Ease affects tie reach **only**, not body width. The zero lower bound prevents negative bridging lengths. A body wider than the eased waist raises an overlap warning. This is a simple coverage approximation, not a model of the body surface or assurance of a suitable bow.

For desired finished strap/tie width `S`, each open seamline rectangle is `2*S` wide. One neck rectangle uses `neckStrapLength`; two separate waist-tie rectangles use the calculated tie length. For allowance `A`, their cut sizes are:

- Width: `2*S + 2*A`.
- Neck length: `neckStrapLength + 2*A`.
- Each waist tie length: `tieLength + 2*A`.

Fold each strip lengthwise, stitch the long seam, and turn. Its short ends are caught in the body seam. The rectangular seamline is a construction reference; the free strip's short ends do not need to be separately closed before attachment. Body top attachment ticks locate the neck strap's two ends. Side ticks locate tie edges just below the waist level. Tick marks are **reference marks**, not cut slits. Baste the straps inward, sew the outer and lining right sides together while leaving a turning gap, turn, and close the gap. This is a construction outline, not a tested step-by-step sewing tutorial.

## True seam offset

The apron and strap seamline polygons are strictly convex and CCW. For every edge vector `(dx,dy)`, its outward unit normal is `(dy,-dx)/length`. The cutline is the intersection of adjacent lines shifted by `seamAllowance` along those normals. Consequently every cutline edge is exactly the requested perpendicular distance from its corresponding seamline edge. Corners are mitred. This is **not** scaling around a centroid, and the offset function is never used on imported or arbitrary concave shapes.

Numeric bounds and dependent checks keep the construction valid:

- Bib width must be at least 80 mm narrower than body width.
- At least 200 mm must remain below the bib.
- Bib width must allow both finished straps plus 40 mm clearance.
- Zero seam allowance is supported, with a conspicuous warning.

The generated body cut bounding dimensions are `W + 2*A` and `H + 2*A`. Separate pieces are laid out with gaps larger than their allowance. No nesting/grain optimization is claimed.

## Reference geometry and output checks

Every piece has a grainline, and strap/tie pieces have fold references. All labels, placement ticks, grainlines, seamlines and the 50 × 50 mm calibration square are on the **reference** layer. The body and strip outside boundaries are on **cut**. Apron references must be included in pattern-print output but **must not be sent as cutting paths**. The 50 mm square verifies output scale; it is not a cut piece. Print at 100% and measure it before use. No tiled-print assembly, shrinkage compensation, seam walking, automatic fitting, or professional grading is provided by this module.

Use a toile before cutting final fabric. Check finished body coverage, neck strap length, strap placement, tie reach, intended ease and the planned sewing/turning method. The draft supplies actual cut boundaries and separate pieces, but it remains explicitly **DRAFT / UNTESTED FIT**.

## Tests

Run `node --test tests/templates.test.mjs`.

The tests cover bilingual metadata, mutation isolation, model compatibility, finite/non-self-intersecting contours, cut/engrave/reference separation, hole orientation/containment, editable dimensions, exact edge-normal offsets at multiple allowances, separate pieces, cut quantities, grainlines/notches, calibration size, boundary cases, and explicit rejection of malformed or incompatible inputs.
