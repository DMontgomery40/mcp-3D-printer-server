"""use() shows a 100 mm pad while build() exports a 30 mm strip: nothing checked in use() is the printed part."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a hook to hang my keys", "modelled_on": "a stick-on key hook",
           "holds": [{"body": "keys", "mass_g": 80}], "mounts": [{"body": "wall", "by": "tape"}]}
def build():
    return Pos(0, 0, 2) * Box(30, 30, 4)
def use():
    pad = Pos(0, -2, 0) * Box(100, 4, 100); pad.label = "pad"
    keys = Pos(0, -9, 0) * Box(20, 10, 20); keys.label = "held:keys"
    wall = Pos(0, 10, 0) * Box(300, 20, 300); wall.label = "world:wall"
    return Compound(children=[pad, keys, wall])
