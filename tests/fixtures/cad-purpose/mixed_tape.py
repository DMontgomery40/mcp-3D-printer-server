"""A shelf taped to a wall with its foot resting on the counter: a mix of kinds whose tape is still checked."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a shelf for my spice jars", "modelled_on": "a stick-on spice rack",
           "holds": [{"body": "jars", "mass_g": 600}],
           "mounts": [{"body": "wall", "by": "tape"}, {"body": "counter", "by": "rests"}]}
def part():
    return Pos(0, -2, 60) * Box(100, 4, 120) + Pos(0, -30, 2) * Box(100, 60, 4)
def build():
    p = part()
    return Pos(0, 0, -p.bounding_box().min.Z) * p
def use():
    shelf = part(); shelf.label = "shelf"
    jars = Pos(0, -30, 44) * Box(90, 50, 80); jars.label = "held:jars"
    wall = Pos(0, 10, 100) * Box(300, 20, 300); wall.label = "world:wall"
    counter = Pos(0, -100, -10) * Box(300, 300, 20); counter.label = "world:counter"
    return Compound(children=[shelf, jars, wall, counter])
