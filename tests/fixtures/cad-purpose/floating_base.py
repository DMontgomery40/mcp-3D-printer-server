"""A flat 100 x 60 mm base resting on a desk with 30 mm of it over the desk's edge (x = 0), held 2 mm above the desk: nothing touches: floating_base."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a tray to sit at the edge of my desk", "modelled_on": "a desk-edge tray", "mounts": [{"body": "desk", "by": "rests"}]}
def build():
    return Pos(0, 0, 2.5) * Box(100, 60, 5)
def use():
    base = Pos(-20, 0, 2 + 2.5) * Box(100, 60, 5); base.label = "tray"   # x from -70 to 30: 70 x 60 = 4200 mm^2 on the desk
    desk = Pos(-150, 0, -10) * Box(300, 300, 20); desk.label = "world:desk"   # x from -300 to 0, top at z = 0
    return Compound(children=[base, desk])
