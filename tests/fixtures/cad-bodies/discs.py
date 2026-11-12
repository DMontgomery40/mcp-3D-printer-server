# Wheels beside their rail after Astra's fidget (council 2026-11-11, scan-to-make #734). floating=1 rebuilds the
# rejected version: the discs start 1.6 mm up, over a 1 mm plate, so their first layer is printed on air.
from build123d import Box, Compound, Cylinder, Pos
P = {"pitch": 35.0, "floating": 0}
def build():
    z0 = 1.6 if P["floating"] else 0.0
    rail = Pos(35, -20.5, 4) * Box(100, 5, 8)
    rail.label = "rail"
    discs = []
    for k in range(3):
        d = Pos(k * P["pitch"], 0, z0 + 2.3) * (Cylinder(12, 4.6) - Cylinder(3.6, 4.6))
        d.label = f"disc {k + 1}"
        discs.append(d)
    return Compound(children=[rail, *discs])
