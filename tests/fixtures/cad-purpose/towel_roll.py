"""A real paper-towel roll, light for its size: 400 g in a roll 280 mm long and 145 mm across on a 40 mm core
(about 0.094 g/cm^3). It lies in a cradle tray resting on the counter; the held body is the object at its real size."""
from build123d import Box, Compound, Cylinder, Pos, Rot
P = {}
PURPOSE = {"for": "a tray that holds a roll of paper towels on my counter", "modelled_on": "a countertop towel tray",
           "holds": [{"body": "roll", "mass_g": 400}], "mounts": [{"body": "counter", "by": "rests"}]}
def build():
    return Pos(0, 0, 2) * Box(300, 150, 4)
def use():
    tray = Pos(0, 0, 2) * Box(300, 150, 4); tray.label = "tray"
    roll = Pos(0, 0, 4 + 72.5) * (Rot(0, 90, 0) * (Cylinder(72.5, 280) - Cylinder(20, 280))); roll.label = "held:roll"
    counter = Pos(0, 0, -10) * Box(600, 400, 20); counter.label = "world:counter"
    return Compound(children=[tray, roll, counter])
