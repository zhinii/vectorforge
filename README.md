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
   3–5 line monospace command console on top, small tool chips under it, the
   canvas gets everything else. The console is a command line that also
   accepts natural language — not a chat app with a canvas attached.

## Current state (v1)

- Parametric entities: line, circle, arc, rect, polygon, star
- Grip dragging (endpoints, radius points, vertices, arc angles) with live
  dimension readout; click/tap a dimension to type a driving value
- Pan (middle/right/two-finger drag), zoom (wheel/pinch), adaptive mm grid
- Undo/redo (document snapshots), delete, keyboard shortcuts (V L C R S A)
- Timeline: every op (human or AI) is a listed entry; the seed of a future
  parametric feature tree
- AI console: paste an `sk-…` key to connect; connection is **verified with a
  real test call** before the AI unlocks; status light in the prompt row
  (grey → amber → green/red); keys stay in memory for this tab only and
  are cleared on reload or Disconnect
- Export: DXF R2000 (LINE/CIRCLE/ARC/LWPOLYLINE, y-up mm) and SVG
- Mobile: full touch support, keypad-sized chips, 3-line console

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
