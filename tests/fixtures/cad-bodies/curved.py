# Curved print-in-place gaps (Muse's review of this check, 2026-11-11): the tessellation screen over-reads a gap between
# curved faces by its chord sag, so curved pairs must still be measured exactly. kind: spheres (two R50 balls), pins
# (two R4 cylinders side by side), pin (a pin in a hole through a block). gap is the true gap between the surfaces.
from build123d import Box, Compound, Cylinder, Pos, Sphere
P = {"kind": "spheres", "gap": 0.28, "print_in_place": True}
def build():
    g = P["gap"]
    if P["kind"] == "spheres":
        a, b = Pos(0, 0, 50) * Sphere(50), Pos(100 + g, 0, 50) * Sphere(50)
    elif P["kind"] == "pins":
        a, b = Pos(0, 0, 10) * Cylinder(4, 20), Pos(8 + g, 0, 10) * Cylinder(4, 20)
    else:   # a 6 mm pin standing in a hole through a block, the hole larger by the gap all round
        a = Pos(0, 0, 5) * Box(20, 20, 10) - Pos(0, 0, 5) * Cylinder(3 + g, 10)
        b = Pos(0, 0, 8) * Cylinder(3, 16)
    a.label, b.label = "a", "b"
    return Compound(children=[a, b])
