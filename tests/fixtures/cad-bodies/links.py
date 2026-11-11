# Print-in-place link fabric after Fable's chainmail (council 2026-11-11, scan-to-make #734): square links on a
# checkerboard, bed bars under the diagonal neighbours' bridges. post_grow 0.5 leaves 1.4 mm between posts two cells
# along; 1.1 leaves 0.2 mm (welds when printed); 1.2 makes them touch (the first version, which passed as valid).
from build123d import Box, Compound, Pos
P = {"n": 3, "s": 5.0, "w": 1.6, "d": 7.0, "low_h": 1.4, "gap_z": 1.2, "high_h": 1.4, "post_grow": 0.5, "print_in_place_clearance_mm": 0.3}
def link(x, y):
    s, w, lo, top = P["s"], P["w"], P["low_h"], P["low_h"] + P["gap_z"] + P["high_h"]
    o, i, q = s + w / 2, s - w / 2, s + w / 2 + P["post_grow"]
    parts = [Pos(sx * s, 0, lo / 2) * Box(w, 2 * i, lo) for sx in (-1, 1)]
    parts += [Pos(0, sy * s, top - P["high_h"] / 2) * Box(2 * i, w, P["high_h"]) for sy in (-1, 1)]
    parts += [Pos(sx * (i + q) / 2, sy * (i + q) / 2, top / 2) * Box(q - i, q - i, top) for sx in (-1, 1) for sy in (-1, 1)]
    body = parts[0]
    for p in parts[1:]: body = body + p
    body = Pos(x, y, 0) * body
    body.label = f"link {x:g},{y:g}"
    return body
def build():
    return Compound(children=[link(i * P["d"], j * P["d"]) for i in range(P["n"]) for j in range(P["n"]) if (i + j) % 2 == 0])
