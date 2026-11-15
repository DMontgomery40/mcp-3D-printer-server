"""A 2 kg tool on a 20 x 20 mm taped pad, 80 mm out from the wall: the tape fails, computed from the geometry."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a holder for my drill on the garage wall", "modelled_on": "a stick-on tool holder",
           "holds": [{"body": "drill", "mass_g": 2000}], "mounts": [{"body": "wall", "by": "tape"}]}
def part():
    return Pos(0, -2, 0) * Box(20, 4, 20) + Pos(0, -40, -8) * Box(20, 76, 4)
def build():
    p = part()
    return Pos(0, 0, -p.bounding_box().min.Z) * p
def use():
    holder = part(); holder.label = "holder"
    drill = Pos(0, -60, 54) * Box(60, 60, 120); drill.label = "held:drill"
    wall = Pos(0, 10, 0) * Box(300, 20, 300); wall.label = "world:wall"
    return Compound(children=[holder, drill, wall])
