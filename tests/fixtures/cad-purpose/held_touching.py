"""The same cradle with its phone resting on its back face (touching, not inside): it carries the phone."""
from build123d import Box, Compound, Pos, Rot
P = {}
PURPOSE = {"for": "a cradle to hold my phone on the wall", "modelled_on": "a stick-on phone cradle",
           "holds": [{"body": "phone", "mass_g": 80}], "mounts": [{"body": "wall", "by": "tape"}]}
def build():
    return Pos(0, 0, 2) * Box(30, 30, 4)
def use():
    part = Pos(0, -2, 0) * Rot(90, 0, 0) * Box(30, 30, 4); part.label = "cradle"
    phone = Pos(0, -9, 0) * Box(40, 10, 40); phone.label = "held:phone"   # y from -14 to -4: on the part's face
    wall = Pos(0, 10, 0) * Box(300, 20, 300); wall.label = "world:wall"
    return Compound(children=[part, phone, wall])
