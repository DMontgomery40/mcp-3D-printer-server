"""The towel-holder pattern: the cabinet modelled as a block shaped to the bracket's taped top, not the cabinet."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a holder under my kitchen cabinet for a roll of paper towels", "modelled_on": "a stick-on towel holder",
           "holds": [{"body": "roll", "mass_g": 200}], "mounts": [{"body": "cabinet", "by": "tape"}]}
def part():
    return Pos(0, 0, -2) * Box(60, 60, 4) + Pos(0, 0, -40) * Box(10, 60, 76)
def build():
    p = part()
    return Pos(0, 0, -p.bounding_box().min.Z) * p
def use():
    bracket = part(); bracket.label = "bracket"
    roll = Pos(35, 0, -60) * Box(60, 60, 60); roll.label = "held:roll"
    cabinet = Pos(0, 0, 2) * Box(60, 60, 4); cabinet.label = "world:cabinet"
    return Compound(children=[bracket, roll, cabinet])
