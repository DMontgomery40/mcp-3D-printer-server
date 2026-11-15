"""a 2000 x 2000 mm base on the 300 x 20 mm shelf: 300 x 20 = 6000 mm^2 on it, and the contact stays cheap to find."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a tray to sit on a narrow shelf", "modelled_on": "a shelf-top tray", "mounts": [{"body": "shelf", "by": "rests"}]}
def build():
    return Pos(0, 0, 2.5) * Box(2000, 2000, 5)
def use():
    base = Pos(0, 0, 0 + 2.5) * Box(2000, 2000, 5); base.label = "tray"
    shelf = Pos(0, 0, -10) * Box(300, 20, 20); shelf.label = "world:shelf"   # top at z = 0
    return Compound(children=[base, shelf])
