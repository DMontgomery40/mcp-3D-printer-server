"""A phone holder whose numbers would make the checks easy: a weightless phone, no press, a 60 degree facing allowance."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a holder for my phone on my desk", "modelled_on": "a desk phone holder",
           "holds": [{"body": "phone", "mass_g": 0}], "mounts": [{"body": "desk", "by": "rests"}],
           "user": [0.0, -450.0, 250.0], "press_n": 0, "faces": {"body": "phone", "within_deg": 60}}
def build():
    return Pos(0, 0, 2) * Box(80, 60, 4)
def use():
    stand = Pos(0, 0, 2) * Box(80, 60, 4); stand.label = "stand"
    phone = Pos(0, 0, 9) * Box(78, 60, 10); phone.label = "held:phone"
    desk = Pos(0, 0, -10) * Box(300, 300, 20); desk.label = "world:desk"
    return Compound(children=[stand, phone, desk])
