"""a 100 x 60 mm base centred across a 300 x 20 mm shelf, over both of its edges: 100 x 20 = 2000 mm^2 on it, and no corner of the base on the shelf."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a tray to sit on a narrow shelf", "modelled_on": "a shelf-top tray", "mounts": [{"body": "shelf", "by": "rests"}]}
def build():
    return Pos(0, 0, 2.5) * Box(100, 60, 5)
def use():
    base = Pos(0, 0, 0 + 2.5) * Box(100, 60, 5); base.label = "tray"
    shelf = Pos(0, 0, -10) * Box(300, 20, 20); shelf.label = "world:shelf"   # top at z = 0
    return Compound(children=[base, shelf])
