# Contact with the print plate (Z = 0 of the exported frame; Muse's review, 2026-11-11). case: floating (one box 10 mm
# up), below (one box centred on the origin, half under the plate), pair (two boxes both 5 mm up), lid (a lid 0.4 mm
# over a box: it rests on the box, a print-in-place stack, not a problem), beside (a box 10 mm up, 0.4 mm beside a
# taller grounded box: nothing is under it; Codex review, 2026-11-11), on (one box on the plate).
from build123d import Box, Compound, Pos
P = {"case": "on"}
def build():
    c = P["case"]
    if c == "floating": return Pos(0, 0, 15) * Box(10, 10, 10)
    if c == "below": return Box(10, 10, 10)
    if c == "pair":
        a, b = Pos(0, 0, 10) * Box(10, 10, 10), Pos(20, 0, 10) * Box(10, 10, 10)
    elif c == "beside":
        a, b = Pos(5, 5, 10) * Box(10, 10, 20), Pos(15.4, 5, 15) * Box(10, 10, 10)
    elif c == "lid":
        a, b = Pos(0, 0, 5) * Box(20, 20, 10), Pos(0, 0, 11.4) * Box(20, 20, 2)
    else:
        return Pos(0, 0, 5) * Box(10, 10, 10)
    a.label, b.label = "a", "b"
    return Compound(children=[a, b])
