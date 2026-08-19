# Map and asset scripts

## `generate-map.mjs`

Emits the starter office to `public/maps/office.json` in Tiled format. The
output is a normal Tiled file — open and edit it in Tiled from here on. This
script exists so the starting point is reproducible, not so maps are generated
forever.

```bash
node scripts/generate-map.mjs
```

## `find-fill-tiles.py`

Lists tiles that can safely be painted across a floor.

**Read this before picking a tile index.** Most of an atlas is 3×3 border sets:
corners, edges, and one interior. Painting an edge tile across a room renders a
grid of stripes, and it is not obvious from the index which kind you have.

Two filters, both learned the hard way:

1. **Seamless** — left edge matches right, top matches bottom. 37 of the
   Kenney atlas's 486 tiles pass. Tiles 118 and 144 do not, and using them
   painted the whole floor in stripes.
2. **Near-uniform** — few colours, low contrast. A window pane is perfectly
   seamless and tiles into a wall of glass; tile 68 passed the first filter and
   still rendered the lounge as a grid of window frames. Only **7** tiles pass
   both.

Every floor and wall index in `generate-map.mjs` comes from the first list.

```bash
python3 scripts/find-fill-tiles.py
```
