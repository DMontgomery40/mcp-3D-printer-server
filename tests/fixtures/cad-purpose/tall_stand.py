"""A stand that rests on a desk, holding a phone high over a small base."""
from build123d import Box, Compound, Pos
P = {"base": 30.0}
PURPOSE = {"for": "a stand to hold my phone on my desk", "modelled_on": "a desk phone stand",
           "holds": [{"body": "phone", "mass_g": 230}], "mounts": [{"body": "desk", "by": "rests"}],
           "user": [0.0, -450.0, 250.0]}
def stand():
    return Pos(0, 0, 2) * Box(P["base"], P["base"], 4) + Pos(0, 0, 64) * Box(10, 10, 120)
def build():
    return stand()
def use():
    s = stand(); s.label = "stand"
    phone = Pos(0, -10, 150) * Box(78, 10, 160); phone.label = "held:phone"
    desk = Pos(0, 0, -10) * Box(300, 300, 20); desk.label = "world:desk"
    return Compound(children=[s, phone, desk])
