"""A 'phone' modelled as a 20 mm cube weighing 250 g: not the object at its real size."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a stand for my keys on my desk", "modelled_on": "a key tray",
           "holds": [{"body": "keys", "mass_g": 250}], "mounts": [{"body": "desk", "by": "rests"}]}
def build():
    return Pos(0, 0, 2) * Box(80, 60, 4)
def use():
    tray = Pos(0, 0, 2) * Box(80, 60, 4); tray.label = "tray"
    keys = Pos(0, 0, 9) * Box(10, 10, 10); keys.label = "held:keys"
    desk = Pos(0, 0, -10) * Box(300, 300, 20); desk.label = "world:desk"
    return Compound(children=[tray, keys, desk])
