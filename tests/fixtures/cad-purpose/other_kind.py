"""The 30 mm strip again, its tape declared as 'other' so the tape check would be skipped."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a squeezy holder for an iPhone 16 Pro on my dash", "modelled_on": "a taped dash phone holder",
           "holds": [{"body": "phone", "mass_g": 250}], "mounts": [{"body": "dash", "by": "other"}],
           "user": [0.0, -600.0, 0.0]}
def part():
    return Pos(0, -3, 0) * Box(120, 6, 30) + Pos(0, -18, 0) * Box(20, 24, 10) + Pos(0, -32, 0) * Box(80, 4, 20)
def build():
    p = part()
    return Pos(0, 0, -p.bounding_box().min.Z) * p
def use():
    holder = part(); holder.label = "holder"
    phone = Pos(0, -40, 0) * Box(78, 12, 160); phone.label = "held:phone"
    dash = Pos(0, 10, 0) * Box(300, 20, 200); dash.label = "world:dash"
    return Compound(children=[holder, phone, dash])
