"""80 g of keys modelled as a 300 mm cube: a body far larger than the object (0.003 g/cm^3)."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a tray for my keys on my desk", "modelled_on": "a key tray",
           "holds": [{"body": "keys", "mass_g": 80}], "mounts": [{"body": "desk", "by": "rests"}]}
def build():
    return Pos(0, 0, 2) * Box(80, 60, 4)
def use():
    tray = Pos(0, 0, 2) * Box(80, 60, 4); tray.label = "tray"
    keys = Pos(0, 0, 154) * Box(300, 300, 300); keys.label = "held:keys"
    desk = Pos(0, 0, -10) * Box(600, 600, 20); desk.label = "world:desk"
    return Compound(children=[tray, keys, desk])
