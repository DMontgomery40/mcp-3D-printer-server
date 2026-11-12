"""Fluted clamping knob that captures an M6 hex bolt head
Use for: a knob, thumbwheel or handwheel that takes a bought bolt or nut; replacing a lost appliance or jig knob
Pattern: revolve a rounded 2D profile, then pattern a cutter round the axis (polar flutes) and cut the hex pocket
Modelled on: JW Winco GN 7336 hollow knurled knob, size 34 (https://www.jwwinco.com/en-us/products/2.2-Tensioning-clamping-with-handles/Knurled-knobs/GN-7336-Plastic-Hollow-Knurled-Knobs-without-Tapped-Insert)
Published sizes used: grip diameter d1 = 34, hub d3 = 16, height h1 = 21, bore d4 = 6.1, hexagon A/F = 10 (maker, URL above, converted from its inch table); M6 hex head across flats s = 10, head height k = 4 (ISO 4017, https://boltsparts.github.io/en/parts/standards/ISO4017.html)
Concept: A thumb knob that turns an ordinary M6 hex bolt into a clamping screw. The bolt drops in from the top, its head sits in the hex pocket and the thread leaves through the hub. Turning the knob drives the six flats; tightening pulls the head down onto the pocket floor, which is the full solid hub, so the clamp load goes straight through the hub into the work. Prints as modelled: hub on the bed, hex pocket UP, no supports, because the underside of the grip is a 45 degree cone and the pocket is open to the top. PETG or PLA, 4 walls. One body.
What makes this good: the crowned top and rounded rim sit in the palm, and eighteen finger-width flutes give grip without sharp teeth.
"""
from build123d import *

P = {
    "grip_d": 34.0,      # d1, the diameter the fingers hold (maker)
    "hub_d": 16.0,       # d3, the narrow hub that bears on the work (maker)
    "height": 21.0,      # h1, overall (maker)
    "bore_d": 6.1,       # d4, through hole for the M6 thread (maker)
    "hex_af": 10.0,      # s, M6 head across flats (ISO 4017)
    "head_k": 4.0,       # k, M6 head height (ISO 4017)
    "fit": 0.3,          # print allowance added to the hex A/F and the bore diameter
    "head_recess": 1.0,  # how far the head sits below the crown, so the palm never feels it
    "hub_h": 3.0,        # straight hub before the 45 degree cone starts
    "crown": 2.5,        # rise of the domed top above the rim
    "rim_round": 2.5,    # radius on the rim's top and bottom corners
    "flutes": 18,        # grooves round the rim, about one per 6 mm of rim
    "flute_r": 2.4,      # radius of each groove cutter (a fingertip-sized scallop)
    "flute_depth": 1.1,  # how deep each groove bites into the rim
}


def build():
    R, r_hub, H = P["grip_d"] / 2, P["hub_d"] / 2, P["height"]
    z_cone = P["hub_h"] + (R - r_hub)   # 45 degree underside: it rises as far as it widens, so it prints unsupported
    z_rim = H - P["crown"]

    # Half profile in (radius, height): crown arc that is flat at the axis, rim, 45 degree cone, hub with a bed chamfer.
    crown = TangentArc((0, H), (R, z_rim), tangent=(1, 0))
    side = Polyline((R, z_rim), (R, z_cone), (r_hub, P["hub_h"]), (r_hub, 0.6), (r_hub - 0.6, 0), (0, 0), (0, H))
    profile = make_face([crown, side])
    rim_corners = profile.vertices().sort_by(Axis.X)[-2:]          # the two corners at the grip radius
    profile = fillet(rim_corners, P["rim_round"])                   # round them in 2D, before revolving
    body = revolve(Plane.XZ * profile, Axis.Z)

    # Pattern one groove cutter round the axis. Its centre is outside the rim so only a shallow scallop is cut.
    pitch_r = R + P["flute_r"] - P["flute_depth"]
    groove = Cylinder(P["flute_r"], 3 * H)   # full height: it fades out down the cone and never reaches the hub
    body -= [loc * groove for loc in PolarLocations(pitch_r, P["flutes"])]

    # Hex pocket for the bolt head (open to the top) and the through hole for its thread.
    floor_z = H - P["head_recess"] - P["head_k"]
    pocket = extrude(RegularPolygon((P["hex_af"] + P["fit"]) / 2, 6, major_radius=False), H)
    bore = Cylinder((P["bore_d"] + P["fit"]) / 2, 3 * H)
    return body - Pos(0, 0, floor_z) * pocket - bore
