"""Round 7b in build123d: a phone square to the cabin on a 120 x 30 mm taped strip, the driver's eye off to the left."""
from build123d import Box, Compound, Pos, Rot
P = {"strip_h": 30.0}
PURPOSE = {
    "for": "a squeezy holder for an iPhone 16 Pro on a 2016 Forester's dash, where the driver can see and reach it",
    "modelled_on": "a taped dash phone holder",
    "holds": [{"body": "phone", "mass_g": 250}],
    "mounts": [{"body": "dash", "by": "tape"}],
    "user": [-350.0, -600.0, 150.0],
}
def part():                                     # the dash face is the plane y = 0; the cabin is -Y
    return Pos(0, -3, 0) * Box(120, 6, P["strip_h"]) + Pos(0, -18, 0) * Box(20, 24, 10) + Pos(0, -32, 0) * Box(80, 4, 20)
def build():
    return Pos(0, 0, 3) * (Rot(-90, 0, 0) * part())
def use():
    holder = part(); holder.label = "holder"
    phone = Pos(0, -40, 0) * Box(78, 12, 160); phone.label = "held:phone"       # screen faces -Y, square to the cabin
    dash = Pos(0, 10, 0) * Box(300, 20, 200); dash.label = "world:dash"
    return Compound(children=[holder, phone, dash])
