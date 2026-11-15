"""A 150 x 100 x 0.3 mm photo buried whole in the middle of a 20 mm slab: its overlap is thin, but all of it is inside the part."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a frame to hold a photo on the wall", "modelled_on": "a stick-on photo frame",
           "holds": [{"body": "photo", "mass_g": 10}], "mounts": [{"body": "wall", "by": "tape"}]}
def build():
    return Pos(0, 0, 10) * Box(160, 110, 20)
def use():
    frame = Pos(0, 0, 10) * Box(160, 110, 20); frame.label = "frame"
    photo = Pos(0, 0, 10) * Box(150, 100, 0.3); photo.label = "held:photo"   # wholly inside the frame
    wall = Pos(0, 0, -10) * Box(400, 400, 20); wall.label = "world:wall"
    return Compound(children=[frame, photo, wall])
