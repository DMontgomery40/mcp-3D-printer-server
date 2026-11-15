"""use() shows a 100 x 100 x 0.36 mm pad while build() exports a 30 x 30 x 4 mm strip: the same 3600 mm^3, not the same part."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a hook to hang my keys", "modelled_on": "a stick-on key hook",
           "holds": [{"body": "keys", "mass_g": 80}], "mounts": [{"body": "wall", "by": "tape"}]}
def build():
    return Pos(0, 0, 2) * Box(30, 30, 4)
def use():
    pad = Pos(0, -0.18, 0) * Box(100, 0.36, 100); pad.label = "pad"
    keys = Pos(0, -10.36, 0) * Box(40, 20, 40); keys.label = "held:keys"
    wall = Pos(0, 10, 0) * Box(300, 20, 300); wall.label = "world:wall"
    return Compound(children=[pad, keys, wall])
