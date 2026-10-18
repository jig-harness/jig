# The jig's model

The home page's jig is a self-centering doweling jig: two jaws on guide
rods close on a board when the T-handle turns, drill bushings drop into
the guide block on top, and a bit descends through the centre bushing. It
holds the work and guides the tool, which is the sentence the hero makes.

`public/models/doweling-jig.glb` is built from the files here, in Blender
4.5 (the generator uses its Python API):

- `parameters.json`: the parts' sizes and positions, in millimetres, and
  the clip's length and frame rate; change the jig here. The guide-hole and
  side-bushing spacing, the handle and the bit's point and flutes are
  drawn in `build.py`.
- `build.py`: builds the parts from primitives and Booleans, bakes the
  `close` animation (`last_frame` frames at `fps`: the jaws close and the
  screw turns twice over the first 55%, the side bushings seat by 80%, and
  the bit descends to the board's top face while the screw turns a last
  quarter), checks the result, writes the GLB and `.blend`, and renders
  the check poses (open, clamped, seated, at the board).
- `primitives.py`: the geometry helpers `build.py` uses.
- `uv_map.py`: the unwrap at metric scale: adjacent faces of one surface
  (a cylinder's wall, a flat side) that share their edges' coordinates
  join into one chart, and the faces developed on their own (the bit's
  flutes and point, the handle hub's facets) get a chart each.
- `render_previews.py`: the same poses at 1600 by 900 with line rendering.

```sh
Blender --background --factory-startup --python website/models/doweling-jig/build.py
bunx @gltf-transform/cli optimize website/models/doweling-jig/doweling-jig.glb website/public/models/doweling-jig.glb \
  --compress meshopt --texture-compress false --simplify false --prune-attributes false
```

The second step compresses the mesh (the threaded screw is most of it)
from about a megabyte to a quarter of that; the page decodes it with
three.js's meshopt decoder. The page draws the model itself
(`src/scripts/jig-model.ts`): the GLB's materials are not used, only its
parts (`Board`, `JawNear`, `JawFar`, `RodLeft`, `RodRight`, `Screw`,
`Handle`, `Block`, `BushingCentre`, `BushingLeft`, `BushingRight`, `Bit`)
and its `close` clip, which the page scrubs by scroll.

Every part but the screw also carries a [UV map](../../../GLOSSARY.md)
(`TEXCOORD_0`): its surface unfolded flat, so every point on it has two
coordinates, U and V, measured on the unfolded surface. `uv_map.py`
unwraps it at one unit of those coordinates per 100 mm of surface, with U
running along the board's length and around the cylinders, so the page can
draw engraved grain and hatching from it without image textures. `uv_skip` in `parameters.json`
names the parts left without one: the screw's thread draws itself through
its edges, and its UVs would be most of the exported file.
