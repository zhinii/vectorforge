# VectorForge — AI-powered 2D CAD sketcher

**Live app:** https://zhinii.github.io/vectorforge/

VectorForge is a browser-based 2D CAD program where a human and an LLM
(currently Qwen, via Alibaba's OpenAI-compatible endpoint) edit the **same
parametric drawing** through the **same operation API**. It is a sibling
project of the [bnta-robotics](https://github.com/zhinii/bnta-robotics)
six-axis robot simulator and reuses its agent architecture: a hardened relay,
a strict JSON action schema, and a validate → execute → repair loop.

No build step. Plain HTML/CSS/ES modules. GitHub Pages serves it as-is.

---

## The goal (read this first, AI agents)

The project is **not** "generate SVG from text." It is an experiment in
**mixed-initiative CAD**: the LLM proposes geometry as structured operations,
the human corrects it by direct manipulation (dragging grips, typing
dimensions), and the LLM reads the resulting parametric state for the next
turn. The design principles, in order of importance:

1. **The data model is parametric, not pixel-based.** Entities are defined by
   parameters (center, radius, width…), never by baked point lists. Every
   shape always carries dimensions.
2. **Dimensions are drivers, not annotations.** A dimension is bidirectional:
   dragging geometry updates it; typing a new value reshapes the geometry.
3. **One shared language: ops.** The LLM, the toolbar, the console, and the
   undo system all emit the same op objects (`{op:"circle", center, radius}`).
   There is exactly one executor: `applyOps()` in `js/model.mjs`. If you add a
   capability, add an op — don't add a side channel.
4. **The LLM receives parametric state, not pixels.** `serializeScene()` sends
   entity ids, types, parameters and the current selection. Compact,
   unambiguous, and lets the model reason about features ("the 25 mm hole")
   instead of coordinates.
5. **Never trust the model's output.** All ops are schema-validated before
   execution; invalid responses get one bounded repair retry; nothing is
   applied partially. Same discipline for the network: the API key is only
   ever sent to the configured CAD relay and whitelisted Alibaba domains, and the light stays red until a
   real round-trip succeeds.
6. **CAD conventions over chat conventions.** The UI follows Rhino's model: a
   roughly 8-line monospace command console on top, small tool chips under it, the
   canvas gets everything else. The console is a command line that also
   accepts natural language — not a chat app with a canvas attached.

## Current state

- Line, circle, arc, rectangle, polygon, star, cubic Bézier and editable text entities.
- Visible Copy/Paste/Delete, undo/redo and keyboard shortcuts. Copies receive new IDs and a screen-space offset; the OS clipboard is not accessed.
- Geometry snapping to endpoints, midpoints, centers and nearest outlines, with screen-space tolerance and a visible target. Moving a whole shape snaps its vertices, edge midpoints or center to another outline, without resizing or rotation; Bézier control handles are not treated as outline anchors. Lines also offer finite perpendicular feet and analytic circle/arc tangents. These are placement aids, not permanent constraints.
- Up to three nearby edge measurements for a selected shape. Circle measurements distinguish center-to-edge distance from boundary clearance. Green measurement labels can be selected and dragged without moving geometry; their positions are undoable. A line wholly inside a circle has a positive distance to the circumference, not a signed overlap value.
- Bézier: click start, first handle, second handle, end; select and drag the four grips. Endpoint/midpoint snapping is exact; nearest-outline snapping uses bounded adaptive numerical search with a 0.01 screen-pixel distance-accuracy target. Curve tangent/perpendicular snapping and proximity measurements remain omitted, not presented as exact.
- Text: click a baseline position, enter one line and its font size. Editable text is not an outlined laser/CNC cutting path. Font bounds used for picking are approximate and excluded from geometric measurements.
- English / 简体中文 switch translates the interface, errors, dimensions and help locally, without an API call. AI replies are requested in the selected language; schema names remain English.
- Saved server key is the public prototype default, with no sign-in or key paste. Click Connect for a free health handshake and explicit drawing-service readiness message; no automatic connection occurs on startup. Only a successful AI request validates the provider. Optional BYOK remains tab-memory only and never falls back to the saved key if rejected.
- Selection, pan and zoom do not invalidate a running AI request; its submitted target selection is frozen. Geometry changes stop stale requests.
- Exact SVG Bézier curves; DXF Béziers are sampled polylines (0.05 mm target tolerance, 4096-segment cap). Text exports as SVG text or DXF TEXT, not outlines.
- Touch pan/pinch, visible undo/delete, eight-line console, and visual-viewport-contained dialogs and Timeline.

## Architecture

```
index.html      layout: console (top) / chip row / canvas / timeline drawer
style.css       dark CAD UI, mobile rules
js/model.mjs    parametric entities, grips, driving dimensions, ops executor,
                scene serialization for the LLM — the geometry kernel
js/agent.mjs    Qwen connection (endpoint whitelist, relay fallback),
                ops schema validation, repair retry
js/main.mjs     canvas rendering, interaction, dimension editing, console
js/dxf.mjs      DXF R2000 + SVG export
server/         CAD relay (see below) + its system prompt + deploy docs
```

### The op schema (the contract)

The LLM returns `{"reply": str, "needsInput": bool, "ops": [...]}`.
Valid ops (validated in `js/agent.mjs`, executed in `js/model.mjs`):

| op | params | effect |
|---|---|---|
| `line` | `from`, `to` | new line |
| `bezier` | `from`, `control1`, `control2`, `to` | cubic Bézier |
| `text` | `at`, `text`, `size` | single-line editable text |
| `circle` | `center`, `radius` | new circle |
| `arc` | `center`, `radius`, `start`, `end` (deg, CCW) | new arc |
| `rect` | `center`, `width`, `height` | new rectangle |
| `polygon` | `center`, `radius`, `sides` | new regular polygon |
| `star` | `center`, `radius`, `points`, `innerRatio` | new star |
| `move` | `id`, `to` | translate entity |
| `set_dimension` | `id`, `dimension` (`length`/`radius`/`width`/`height`), `value` | driving-dimension edit; entity rescales |
| `delete` | `id` | remove entity |
| `clear` | — | clear canvas |

Units are millimetres; world coordinates are y-up (DXF-native); origin is the
canvas centre.

### Connection & the relay (important)

Alibaba endpoints send **no CORS headers**, so browsers cannot call them
directly. Requests go through a relay — the same pattern as the robot
simulator's relay, but a **separate CAD route** (`/api/cad-chat`), because the
robot relay validates robot-specific scenes and injects the robot system
prompt. The CAD relay (`server/cad-relay-route.ts`) forwards the per-request browser key without storing it, whitelists origins, validates the scene envelope
(`{question, scene:{units, entities:[...]}}`), rate-limits, and injects the
CAD system prompt server-side. Deploy it before expecting a green light;
see `server/README.md`.

## Roadmap (where contributors/AI agents should push next)

1. **Constraint solver.** Grips currently edit parameters directly. The real
   design: entities + a constraint graph (coincident, parallel, tangent,
   equal, symmetric) with DOF accounting; dragging = a temporary
   move-to-cursor constraint the solver satisfies while holding the rest.
   This is what makes "drag a star tip, the rest follows correctly" work for
   arbitrary geometry.
2. **Timeline as a feature tree.** Ops should become recomputable nodes with
   persistent references ("the segment of line_1 near [40,12]"), so editing an
   upstream parameter re-executes downstream ops instead of corrupting them.
3. **Trim/extend/fillet/chamfer/offset as constraint-generating ops** —
   a fillet is an arc plus tangent constraints plus trimmed neighbours, not a
   bare arc. Click-side selection (`keep_point`) resolves ambiguity.
4. **Typed console commands** (`line 0,0 80,0`, `circle 0,0 r25`) parsed
   locally onto the same ops executor — no LLM round-trip for exact input.
5. **Visual feedback loop**: rasterize the canvas and return it to a
   vision-capable model so the agent can verify its own output.
6. Layers, blocks, snapping (endpoint/midpoint/intersection/perpendicular),
   hatching, and DXF import.

## Conventions for AI contributors

- Never bypass `applyOps` — the LLM schema, the toolbar and the timeline must
  stay in sync by construction.
- Never send the API key anywhere except whitelisted Alibaba domains /
  the configured relay (`validateConnection` enforces this; keep it that way).
- Keep the app dependency-free and build-free; it must run from GitHub Pages
  by opening `index.html` over HTTP.
- Coordinates y-up, millimetres, everywhere except screen space.


## Run and verify

Serve this directory over HTTP, for example `python3 -m http.server 4226`,
then open `http://localhost:4226`. There is no frontend build or install step.
Use Node 24+ for `npm run check` and `npm test`; all tests use mocked provider
responses, never real credentials or paid API calls. GitHub Actions runs these
checks for pushes and pull requests.

API and dimension dialogs have a visible close button, Cancel, Escape, and
outside-click dismissal. The closed Timeline is inert. The Stop button cancels
in-flight requests; changing the drawing discards stale AI results. API keys
are never written to localStorage/sessionStorage or echoed into the console.
The app removes the old persisted `vectorforge.connection` entry on startup.

Static assets and module imports carry a shared release query version. Bump it
in `index.html`, `js/main.mjs`, and `js/dxf.mjs` when shipping changed modules
to prevent returning browsers from combining cached code with new HTML.

Mobile canvas pinch/pan is handled inside the canvas, not as page zoom. The
closed Timeline is removed from layout and workspace overflow is clipped so
it cannot enlarge the mobile page. Browser accessibility zoom outside the
canvas remains available.

## Guided photo tracing and simpler controls (release 14)

The primary strip is **Select · Draw · Shapes · Photo · Undo**. AI prompting stays in a slim bottom console; expand it for eight lines of conversation. Select a photo for **Guided trace · Delete · Options**. Image settings, threshold tracing, dimensioned reconstruction, layers and projects remain available under Options or Advanced, not on the initial canvas.

1. **Photo → Take Photo / Choose Image.** The imported photo is selected on the canvas immediately. No image is uploaded to the AI provider.
2. **Guided trace → tap a few points along the intended edge.** A bounded local contrast/tangent search follows pixels between taps. Place closer points around corners or faint details. **Undo** (including Ctrl+Z) removes a trace point, not the source photo. Pinch/pan remains available.
3. **Finish line** for an open engraving path or **Close outline** for a closed cutting contour. Review the suggested boundary. Weak, interrupted or incoherent texture paths request closer guidance. They also offer an orange **Use suggested line** preview connecting the exact taps; this approximate straight line is added only after your explicit choice. Approximate segments stay orange until final acceptance and their object name retains an approximate label. Repetitive textures and nearby boundaries can still be ambiguous; this is a pixel-guided suggestion, not semantic AI recognition.
4. Optionally choose **Set known length**, tap two endpoints, and enter the real distance in millimetres. The numeric entry stages scale automatically. **Accept** scales this photo and the new trace together in one Undo step; existing vector geometry stays unchanged. Otherwise **Accept unscaled path** explicitly retains unverified size. Verify dimensions before fabrication.
5. Traced segments are cleaned into fewer editable vertices while retaining exact tap anchors and sharp corners. Nearly straight runs become straight segments. The extra cleanup is bounded to 1.5 reduced-image pixels relative to the traced polyline (at most 2.15 pixels including the tracer’s first simplification); it never silently increases tolerance to meet the point budget. Features smaller than this tolerance can disappear, and topology is not guaranteed. This is a polyline, not fitted cubic handles. The accepted path has editable vertices and dimensions. The original photo stays underneath; Delete on a selected photo removes the photo and attached notes, not accepted paths. Undo restores it.

The edge search uses at most 256 pixels on its longest side by default (hard cap 320), bounded memory/work, at most 64 anchors and 512 accepted path points. This reduces fine detail: add guidance, zoom in to inspect the result, and verify scale. Low-contrast rejection is heuristic, not proof of the correct physical edge. Photos are not perspective-corrected; handwritten dimensions are not automatically recognized. Existing assisted reconstruction and AI preview/accept workflows are preserved. See [advanced reconstruction](docs/ASSISTED_SKETCH_WORKFLOW.md).

## Local reference-to-fabrication workflow (release 9)

Use **Photo** for a JPEG/PNG or mobile **Take Photo**. Choose **Advanced import** for a supported standalone SVG. Images never leave the browser and are not sent to the AI relay. Camera capture uses the phone's file/camera picker only when selected. JPEG/PNG inputs are limited to 10 MB and 32 megapixels; the retained underlay is a sanitized copy downsampled to at most 1024 pixels. Keep your original photograph separately. Up to six reference images can be stored in a local project.

1. Rotate/place the image and **Calibrate two points** against a known real distance. Calibration rescales that image and its attached annotations, not already-created vector geometry. Photos are not perspective-corrected; photograph flat paper straight on. There is no OCR or automatic dimensional reconstruction.
2. **Write dimension** or **Add image note** creates reference-only annotations. Drag labels to reposition; edit/remove them in Import. These are user-entered labels, not geometry constraints. Existing blue geometry dimensions actually resize the selected vector entity.
3. Preview a local silhouette trace, adjusting threshold, adaptive lighting, speck removal and simplification. Accept creates editable closed paths; the underlay remains. Thick drawn strokes can produce both outer and inner edges, not a centerline. Inspect for double cuts. Trace manually with Line/Bezier and assign Engrave when that is more appropriate.
4. **Templates** offers parameter-driven T-shirt/dress flats, house/keytag outlines and a measurement-driven lined apron DRAFT. Preview before accepting. See [template formulas and sewing limitations](docs/TEMPLATES.md). Sewing patterns require a 100% scale print/check and test fit; garment flats are illustrations, not cut-and-sew patterns.
5. In **Layers & groups**, assign Cut, Engrave or Reference; group related objects and optionally move the whole group. Paths have editable vertices and driving width/height dimensions. Closed-contour and hole flags are explicit, but hole nesting must be checked in CAM. Dense traces omit optional nearby-edge measurements to keep interaction bounded.
6. **Drawing checks** surfaces open cutting paths, duplicates, tiny or self-crossing contours, units/bounds and unoutlined text. Review warnings before SVG/DXF export. Reference images, annotations and explicit Reference geometry are excluded from cutting exports. Named cut/engrave layers remain in the files. Checks are not machine safety certification: verify scale, material, kerf, placement, tool settings and contours in CAM. The app does not execute a machine.
7. Save/open a local `.vforge` project to preserve editable geometry, reference images and annotations. No API keys or chat history are included. Loading replaces the scene and supports Undo. **Export annotated SVG** includes reference artwork and sewing guides for documentation/printing, not machine cutting.

SVG import is intentionally strict: supported shapes are path M/L/H/V/C/Q/Z, line, polygon/polyline, rect, circle and ellipse with bounded transforms and physical-unit/viewBox scaling. Curves are flattened to editable path vertices. Scripts, external resources, CSS, clipping, text, arcs and unsupported styling are rejected, not silently executed or partially imported. Use the project format for lossless VectorForge roundtrips. Trace complexity, project size and total expanded geometry are bounded; over-limit input is rejected rather than silently truncated. Large geometry scenes remain locally editable/exportable but are blocked from exceeding the AI request size limit.
