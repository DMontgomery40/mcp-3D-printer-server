"""A 60 mm round taped pad, a short post and a cradle turned toward the driver, as the bare models drew it."""
from build123d import Box, Compound, Cylinder, Pos, Rot
P = {"pad_d": 60.0, "aim_deg": -30.0, "tilt_deg": -12.0}
PURPOSE = {
    "for": "a squeezy holder for an iPhone 16 Pro on a 2016 Forester's dash, where the driver can see and reach it",
    "modelled_on": "ProClip / iOttie taped pad with a locking ball swivel",
    "holds": [{"body": "phone", "mass_g": 250}],
    "mounts": [{"body": "dash", "by": "tape"}],
    "user": [-350.0, -600.0, 150.0],
    "material": "ASA",
}
def aim(s):                                     # turned about the ball centre at y = -5
    return Pos(0, -5, 0) * (Rot(0, 0, P["aim_deg"]) * (Rot(P["tilt_deg"], 0, 0) * s))
def pad():
    return Pos(0, -2.5, 0) * (Rot(90, 0, 0) * Cylinder(P["pad_d"] / 2, 5))
def holder():
    head = Pos(0, -15, 0) * (Rot(90, 0, 0) * Cylinder(9, 30)) + Pos(0, -32, 0) * Box(70, 4, 30)
    return pad() + aim(head)
def build():
    return Pos(0, 0, 40) * (Rot(-90, 0, 0) * holder())
def use():
    h = holder(); h.label = "holder"
    phone = aim(Pos(0, -40, 0) * Box(78, 12, 160)); phone.label = "held:phone"
    dash = Pos(0, 10, 0) * Box(300, 20, 200); dash.label = "world:dash"
    return Compound(children=[h, phone, dash])
