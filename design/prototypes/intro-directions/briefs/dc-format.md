# Writing a `.dc.html` artboard (condensed rules; all of them bite silently)

Each artboard is one self-contained file. Skeleton:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hero, light, 1440</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body{margin:0}
a{color:#1a6444}a:hover{color:#005031}
</style>
</helmet>
<div style="width:1440px; height:900px; box-sizing:border-box; ...">
 ... all UI is literal markup here ...
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1440,"height":900}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
```

Rules:
- Keep `<script src="./support.js"></script>` exactly. Close every non-void element, quote every attribute.
- The root div is fixed at the artboard's w x h (box-sizing:border-box), unless told it is a tall page: then fixed width and the height you need (over-tall beats clipped). `$preview` = that w x h.
- Inline `style="..."` for layout and theme colours. `<helmet><style>` only for body reset, `a`/`a:hover`, and things inline style cannot do (pseudo-elements, media queries, @keyframes, scroll-timeline, ::selection). Plain CSS there is fine.
- `{{hole}}` is a dotted lookup only, never an expression. This page is static: write copy as literal markup, not holes.
- No JavaScript-built content (no innerHTML, no appendChild). No iframes/objects/embeds. No network except images given below. No emoji.
- Colours: the artboard is rendered in one theme (the one named in its filename). Write the resolved hex values of that theme directly (see brief.md token table). Do not use light-dark() or CSS variables for theme switching here. Name each hex by its token in a CSS comment where useful.
- Fonts: system stacks only. serif: "Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua","`URW` Palladio L",Georgia,serif ; sans: system-ui,-apple-system,"Segoe UI",Ubuntu,Cantarell,"Noto Sans",sans-serif ; mono: ui-monospace,"`SF` Mono","Cascadia Mono",Consolas,"Liberation Mono",monospace. No web fonts, no Google Fonts.
- Images: use the repository-relative Scalable Vector Graphics (`SVG`) paths given in the brief. Give each a meaningful `alt` (the figure) and explicit width/height. Never a data: `URI`.
- Accessibility as drawn: real <a href>, <button>, headings in order; text contrast 4.5:1 in that theme (3:1 for 24px+). Status (shipped/planned) must survive greyscale: shape, line style or words, never hue alone. Touch targets >= 44px on phone artboards.
- Hatching, rules, key caps, brackets, dashed lines: draw with CSS borders/backgrounds (repeating-linear-gradient for hatch) or small inline <svg aria-hidden="true">. Keep them tokens-only (no new hue).
- Write one file at a time with the Write tool, directly (never a generating script).
