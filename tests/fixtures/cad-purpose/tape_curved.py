"""A pad whose taped back is a curve wrapped on a round post: the tape's contact is not one flat patch."""
from build123d import Box, Compound, Cylinder, Pos
P = {}
PURPOSE = {"for": "a holder for my keys on a round pole", "modelled_on": "a stick-on key holder",
           "holds": [{"body": "keys", "mass_g": 80}], "mounts": [{"body": "pole", "by": "tape"}]}
def part():
    return (Cylinder(24, 30) - Cylinder(20, 30)) & (Pos(0, -20, 0) * Box(60, 40, 30))
def build():
    p = part()
    return Pos(0, 0, -p.bounding_box().min.Z) * p
def use():
    holder = part(); holder.label = "holder"
    keys = Pos(0, -34, 0) * Box(30, 20, 20); keys.label = "held:keys"
    pole = Cylinder(20, 300); pole.label = "world:pole"
    return Compound(children=[holder, keys, pole])
