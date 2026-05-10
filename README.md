# Khaaka — Layout Studio

A **premium, dependency-free in-browser 2D layout editor** for plots, floor plans, and building layouts. Draw rooms, walls, doors, windows, text and measurements with snap-to-grid, ft/in & metric units, autosave, JSON & PNG export — all in a single static page, no build step, no dependencies.

> "Khaaka" (खाका) — a sketch, an outline, a blueprint.

---

## Highlights

- **Zero dependencies, zero build.** Three files: [index.html](index.html), [styles.css](styles.css), [app.js](app.js). Open in any modern browser and you are drawing.
- **Real units.** Work in **feet & inches** (e.g. `12'-3"`) or **meters / cm / mm**. Switch any time — every dimension and input field re-formats live.
- **Snap-to-grid** with selectable grid size, major/minor grid lines, and an origin axis.
- **Six object types**: rooms, walls (with thickness), doors (with swing arc), windows, text labels, and dimension/measurement lines.
- **Properties panel** with color, stroke, size, rotation, and unit-aware position/dimension fields.
- **Layers panel** with category tabs, lock, hide, reorder, and rename.
- **Autosave** to `localStorage` (debounced) plus an explicit Save button. The last saved layout is auto-loaded on page open.
- **Exports**: pretty-printed **JSON** (round-trips losslessly) and high-DPI **PNG**.
- **Undo / Redo** (100 steps).
- **Full keyboard shortcuts** for every tool and editing action.
- **Premium UI** in light theme — Inter + JetBrains Mono, custom inline SVG icon set, no external icon font.

---

## Quick start

No install, no toolchain. Just serve the folder:

```powershell
# from the project root
python -m http.server 5173
# then open http://localhost:5173
```

Or, on Node:

```powershell
npx --yes serve .
```

Or simply double-click [index.html](index.html) — everything runs locally.

> Tip: serving over HTTP (rather than `file://`) is recommended so `localStorage` autosave behaves consistently.

---

## Tools

| Tool          | Shortcut | What it does |
|---------------|:--------:|--------------|
| Select / Move | `V`      | Pick objects, drag to move, drag handles to resize. |
| Room          | `R`      | Click-drag a rectangular room. Label appears centered. |
| Wall          | `W`      | Click-drag a thick wall segment. Thickness is editable. |
| Door          | `D`      | Place a door opening with swing arc. Rotate in properties. |
| Window        | `N`      | Place a window opening. Rotate in properties. |
| Text          | `T`      | Click to drop a text label, then type inline. |
| Measure       | `M`      | Drag a dashed dimension line; length is shown live. |

Right-click on the canvas to switch back to **Select / Move** at any time.

---

## Keyboard shortcuts

### Tools
`V` Select · `R` Room · `W` Wall · `D` Door · `N` Window · `T` Text · `M` Measure

### Editing
| Action       | Shortcut             |
|--------------|----------------------|
| Undo         | `Ctrl` + `Z`         |
| Redo         | `Ctrl` + `Y`         |
| Save         | `Ctrl` + `S`         |
| New          | `Ctrl` + `N`         |
| Delete       | `Delete` / `Backspace` |

### View
| Action       | Shortcut |
|--------------|----------|
| Zoom in      | `+` / `=` |
| Zoom out     | `-`       |
| Reset view   | `0`       |
| Pan          | Middle-mouse drag |
| Smooth zoom  | Mouse wheel       |

> On macOS, use `⌘` (Cmd) instead of `Ctrl`.

---

## Working with units

Switch between **Feet & Inches** and **Meters** in the *Canvas* card. All length inputs in the Properties panel accept flexible formats:

| You can type        | Parsed as |
|---------------------|-----------|
| `12'-3"` / `12'3"`  | 12 ft 3 in |
| `12'`               | 12 ft |
| `36"` / `36 in`     | 36 in |
| `12 ft 3 in`        | 12 ft 3 in |
| `1.5m`              | 1.5 m |
| `150cm`             | 1.5 m |
| `1500mm`            | 1.5 m |
| `3.25` (bare)       | 3.25 of the **current** unit |

Internally, all geometry is stored in **meters**, so files round-trip cleanly regardless of the display unit.

---

## Saving, loading, and exporting

- **Save** — writes the current layout to `localStorage` under the key `plotly.layout.v1`.
- **Auto-load** — the last saved layout is restored automatically when you open the page.
- **Autosave** — every change is debounced and written to `localStorage` automatically.
- **Import** — load a previously exported `.json` file.
- **Export** — downloads a pretty-printed `.json` (project state) or high-DPI `.png` (clean render, no selection halo). Filenames use the project name plus a local timestamp:
  `My Plot_2026-05-10_14-32-08.json`

---

## JSON file format (v1)

The exported JSON is a single object:

```jsonc
{
  "version": 1,
  "projectName": "My Plot",
  "units": "ft",                  // "ft" | "m"
  "pxPerMeter": 164.04,           // derived from grid + render scale
  "pxPerBox": 50,                 // screen pixels per grid cell
  "grid": { "show": true, "snap": true, "size": 0.3048 },
  "showDims": true,
  "defaultWallThickness": 0.1524, // meters (~6")
  "nextId": 12,
  "objects": [ /* see below */ ]
}
```

### Object schema

All coordinates and dimensions are in **meters**. All objects carry: `id`, `type`, `label`, `fill`, `stroke`, `strokeWidth`, and optionally `locked`, `hidden`.

| `type`    | Geometry fields                | Notes |
|-----------|--------------------------------|-------|
| `room`    | `x, y, w, h`                   | Axis-aligned rectangle. |
| `wall`    | `x1, y1, x2, y2, thickness`    | Line segment with stroke thickness in meters. |
| `door`    | `x, y, w, rot`                 | Opening of width `w`, rotation in degrees. Drawn with a 90° swing arc. |
| `window`  | `x, y, w, rot`                 | Opening of width `w`, rotation in degrees. |
| `text`    | `x, y, text, size`             | `size` is in screen pixels. |
| `measure` | `x1, y1, x2, y2`               | Dashed dimension line; label is auto-formatted in the current unit. |

---

## Project structure

```
Khaaka/
├── index.html    # Markup, inline SVG icon library, panel layout
├── styles.css    # Light premium theme (Inter + JetBrains Mono)
├── app.js        # All editor logic — IIFE, no globals leaked
└── README.md
```

[app.js](app.js) is organized in clearly commented sections: state, helpers, object factories, rendering, hit-testing, pointer/keyboard handlers, properties form, layers, clipboard, autosave, serialize / deserialize, and PNG export.

---

## Browser support

Any evergreen browser with HTML5 `<canvas>`, `localStorage`, `FileReader`, and `Blob` (Chrome, Edge, Firefox, Safari). No polyfills required.

---

## Roadmap ideas

- Multi-select and group transforms
- Rotated rooms / non-axis-aligned rectangles
- SVG export
- Background image as a tracing reference
- Print / PDF export with page setup

PRs welcome.

---

## License

No license file is currently included. Add a `LICENSE` (e.g. MIT) before redistributing.
