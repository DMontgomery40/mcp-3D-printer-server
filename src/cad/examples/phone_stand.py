"""One-piece desk phone stand (swan neck, leaning back, two hooks, cable opening)
Use for: propping a phone or tablet on a desk or bedside; any stand that leans a flat device back at a viewing angle
Pattern: loft rounded sections of changing width along a filleted spine (waisted neck into a broad back), then add parts in a tilted Plane
Modelled on: Lamicall S1 desk phone stand (https://thegadgetflow.com/product/lamicall-s1-smartphone-dock/)
Published sizes used: 0.74 in (18.8 mm) = S1 cradle depth (press listing, URL above); iPhone 18 Pro Max 163.4 x 78.0 x 8.75 mm, 249 g (maker, https://support.apple.com/148591); iPhone Duo closed 117.8 x 84.1 x 11.3 mm, open 117.8 x 164.6 x 5.2 mm, 254 g (maker, https://support.apple.com/en-us/148588); every other size is a design choice
Concept: Holds a phone upright or sideways at a reading angle while it charges. The phone's bottom edge sits on two hooks and its back lies on a flat panel leaning 25 degrees; the charging plug hangs between the hooks and the cable leaves through the slot in the neck. The weight runs down the swan neck into the middle of a wide foot: with the tallest iPhone (163.4 mm, 249 g) upright its centre of mass lands about 45 mm in front of the heel and 60 mm behind the toe, and the 18.8 mm cradle takes the thickest (11.3 mm, 254 g) with a case. Prints as modelled, foot on the bed, no supports: the neck leans 35 degrees and the hook undersides 40 degrees from vertical. PLA or PETG, 3 walls; add stick-on rubber dots under the foot.
What makes this good: one continuous lofted spine that narrows to a neck and spreads into the back, so it reads as a designed object, not a bent plate.
"""
from math import cos, radians, sin, tan

from build123d import *

P = {
    "lean_deg": 25.0,      # back leans this far from vertical (65 degree viewing angle)
    "neck_deg": 55.0,      # neck rises forward at this angle above the desk (printable overhang)
    "nose_h": 26.0,        # height of the bend where neck turns into back
    "nose_y": -22.0,       # how far forward of the origin that bend is
    "bend_r": 14.0,        # radius of that bend
    "seat_up": 23.0,       # hooks sit this far up the back from the bend corner
    "back_len": 80.0,      # back panel above the hooks (reaches the middle of a 163.4 mm phone)
    "thick": 5.0,          # spine thickness
    "neck_w": 34.0,        # narrowest width, at the neck (leaves 10 mm each side of the cable slot)
    "back_w": 58.0,        # widest width, behind the phone (phone is 78.0 wide)
    "cradle": 18.8,        # hook depth, front of back panel to lip (published S1 cradle)
    "lip_h": 9.0,          # lip height above the seat
    "lip_t": 4.0,          # lip and seat thickness
    "hook_w": 13.0,        # width of each hook
    "cable_gap": 20.0,     # clear gap between the hooks for the plug
    "slot_len": 30.0,      # cable slot through the neck, measured down the back
    "foot_w": 82.0,        # foot width (wider than the phone)
    "foot_d": 106.0,       # foot depth: toe ahead of the lip, heel behind the phone's centre of mass
    "foot_y": 8.0,         # foot centre, behind the origin
    "foot_t": 5.0,         # foot thickness
    "root_fillet": 3.0,    # blend of the neck into the foot
    "edge_r": 1.9,         # rounding on hooks and panel top (the 4 mm lip becomes a full round)
}

# What it is for, as data: cad_run compiles it into requirements and evaluates them on use() below.
PURPOSE = {
    "for": "a stand that holds my phone on my desk at a reading angle while it charges",
    "modelled_on": "Lamicall S1 desk phone stand",
    "holds": [{"body": "phone", "mass_g": 249}],    # the tallest iPhone it takes
    "mounts": [{"body": "desk", "by": "rests"}],
    "user": [0.0, -450.0, 330.0],                   # a seated person's eye, in front of the stand
}


def build():
    lean, neck, t = radians(P["lean_deg"]), radians(P["neck_deg"]), P["thick"]
    up = Vector(0, sin(lean), cos(lean))        # direction up the back panel
    out = Vector(0, -cos(lean), sin(lean))      # direction out of its front face, towards the phone
    corner = Vector(0, P["nose_y"], P["nose_h"])
    root = corner + Vector(0, 1 / tan(neck), -1) * (P["nose_h"] - P["foot_t"] / 2)  # starts inside the foot
    top = corner + up * (P["seat_up"] + P["back_len"])

    # spine: neck up and forward from the foot, one filleted bend, then the straight leaning back
    spine = Polyline(root, corner, top)
    spine = fillet(spine.vertices(), P["bend_r"])

    # (position along the spine 0..1, width there): flared root, narrow neck, broad back
    # (the last station lies beyond the top, so the panel ends mid-curve with rounded shoulders)
    stations = [(0, 48), (0.18, P["neck_w"]), (0.45, P["back_w"]), (0.8, P["back_w"]), (1.25, P["back_w"] - 40)]

    def width_at(u):  # smooth blend between neighbouring stations
        for (u0, w0), (u1, w1) in zip(stations, stations[1:]):
            if u <= u1:
                k = (u - u0) / (u1 - u0)
                return w0 + (w1 - w0) * (3 * k**2 - 2 * k**3)

    # many evenly spaced sections keep the loft on the spine, so the panel stays flat for the phone
    sections = [Plane(spine @ (i / 24), x_dir=(1, 0, 0), z_dir=spine % (i / 24))
                * RectangleRounded(width_at(i / 24), t, t * 0.45) for i in range(25)]
    back = loft(sections)
    back = fillet(back.faces().sort_by(Axis.Z)[-1].edges(), P["edge_r"])  # soft top edge

    # foot: a pebble-shaped pad, the only thing touching the bed
    foot = Pos(0, P["foot_y"]) * extrude(RectangleRounded(P["foot_w"], P["foot_d"], P["foot_w"] * 0.4), P["foot_t"])
    foot = fillet(foot.edges().group_by(Axis.Z)[-1], P["foot_t"] * 0.6)

    # hooks, drawn in the side plane of the back: x = up the back, y = out towards the phone
    seat = corner + up * P["seat_up"] + out * (t / 2)
    side = Plane(seat, x_dir=up, z_dir=(1, 0, 0))
    reach = P["cradle"] + P["lip_t"]
    hook_profile = side * Polygon(
        (0, -t / 2), (0, P["cradle"]), (P["lip_h"], P["cradle"]), (P["lip_h"], reach),
        (-P["lip_t"], reach), (-P["lip_t"] - reach * tan(lean), -t / 2), align=None)
    hook = extrude(hook_profile, P["hook_w"] / 2, both=True)
    # round the profile first (full-round lip), then the two flanks with a smaller radius:
    # equal fillets meeting at a corner make a spherical patch that does not export watertight
    hook = fillet(hook.edges().filter_by(Axis.X), P["edge_r"])
    hook = fillet(hook.edges().filter_by(Axis.X, reverse=True), P["edge_r"] / 2)
    hook = Pos((P["cable_gap"] + P["hook_w"]) / 2, 0, 0) * hook
    body = foot + back
    # blend the neck into the foot: the seam is the only spline edge on the foot's top face
    seam = body.edges().filter_by_position(Axis.Z, P["foot_t"] - 0.01, P["foot_t"] + 0.01).filter_by(GeomType.BSPLINE)
    body = fillet(seam, P["root_fillet"])
    body += hook + mirror(hook, Plane.YZ)

    # cable slot through the neck between the hooks, from the seat downwards
    rest = Plane(seat, x_dir=(1, 0, 0), z_dir=out)
    slot = extrude(SlotOverall(P["slot_len"], P["cable_gap"] - 6, rotation=90), 2 * t, both=True)
    return body - rest * Pos(0, 3 - P["slot_len"] / 2) * slot


def use():
    """As used: on the desk (Z = 0) with the tallest iPhone (163.4 x 78.0 x 8.75 mm) on the hooks and against the back.
    cad_run checks from this that the stand neither tips nor slides when the screen is pressed, and that the screen
    faces the user's eye."""
    lean = radians(P["lean_deg"])
    up = Vector(0, sin(lean), cos(lean))
    out = Vector(0, -cos(lean), sin(lean))
    seat = Vector(0, P["nose_y"], P["nose_h"]) + up * P["seat_up"] + out * (P["thick"] / 2)
    stand = build()
    stand.label = "stand"
    phone = Pos(*(seat + up * (163.4 / 2) + out * (8.75 / 2))) * (Rot(-P["lean_deg"], 0, 0) * Box(78.0, 8.75, 163.4))
    phone.label = "held:phone"
    desk = Pos(0, P["foot_y"], -10) * Box(300, 300, 20)
    desk.label = "world:desk"
    return Compound(children=[stand, phone, desk])
