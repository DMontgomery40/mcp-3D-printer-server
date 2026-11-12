"""Shelf bracket with a curved brace (6 x 8 in, four countersunk screws)
Use for: holding up a shelf, a worktop extension or a box on a wall; any L bracket, corner brace or support that carries a load out from a wall
Pattern: an L of two legs with the corner filled to an arc, then a filleted window cut out to leave the curved brace, all one profile in the plane the load bends it in, extruded to the bracket's width; countersunk holes cut from the faces a screwdriver can reach
Modelled on: National Hardware 211BC 6 x 8 in steel shelf bracket (https://www.dkhardware.com/national-hardware-n218-891-xcp20-211bc-shelf-bracket-100-lb-6-in-l-steel-pack-of-20-product-6640429.html); screw is SPAX 4.0 mm flat countersunk (https://www.ahlsell.se/en/products/mounting/wood-screw/wood-screw-spax/71333788---traskruv-tft-spax-svart-4.0x25h-200fp-eta-120114)
Published sizes used: 6 x 8 in (152 x 203 mm) = the bought bracket's two legs, with 5/32 in (4 mm) screw holes (retailer listing, first URL); 4.0 mm = screw thread, 8.0 mm = head diameter, 2.4 mm = head height (SPAX listing, second URL); thicknesses and the brace are design choices
Concept: Carries a shelf 150 to 200 mm deep. Frame: the wall is the plane x = 0, the shelf lies on the arm's top face at y = 0. The shelf's weight tries to fold the arm down: the brace takes that as a push along its length into the foot of the wall leg, and the top wall screw takes the matching pull, so the top screw is the one that matters and it sits high, just under the arm. The long leg goes on the wall, where there is more screw spacing. The brace bows a little towards the corner, as on a cast bracket, and the window's corners are filleted so no joint is a sharp notch. This one is rightly an extrusion: it is printed lying on its side, so each layer is the whole L with its brace and the load never pulls layers apart; printed standing, the arm would snap off along a layer. The wall screws are driven through the open window and below the brace's foot; the shelf screws go up from underneath. No supports. PETG or PLA, 5 walls, 40 percent infill; a printed bracket is for books and plants, with no load rating.
What makes this good: the brace follows the load, the screws are where a driver reaches them, and it prints with the layers running round the whole frame.
"""
from build123d import *

P = {
    "arm": 152.0,           # under the shelf, out from the wall (published: 6 in)
    "leg": 203.0,           # down the wall (published: 8 in)
    "width": 28.0,          # bracket width = height off the bed as printed
    "t": 7.0,               # thickness of both legs
    "brace_t": 6.0,         # thickness of the brace
    "brace_in": 16.0,       # brace meets the arm this far in from its tip
    "brace_up": 30.0,       # brace meets the wall leg this far up from its foot
    "bow": 10.0,            # how far the brace bows towards the corner at its middle
    "corner_r": 6.0,        # fillet in the inside corners
    "tip_r": 3.0,           # rounding of the arm tip and leg foot
    "screw_d": 4.0,         # screw thread diameter (published)
    "screw_head_d": 8.0,    # head diameter (published)
    "screw_head_h": 2.4,    # head height (published); sets the countersink depth
    "screw_clear": 0.5,     # added to thread and head diameters
    "edge": 0.8,            # chamfer round both faces of the outline
}


def build():
    t, arm, leg, w = P["t"], P["arm"], P["leg"], P["width"]
    # profile: wall leg down the Y axis, arm along X with its top at y = 0; the brace is what is left between the
    # filled corner and a window cut out of it (a window is a simple face, so its corners fillet; the outline's do not)
    a, b = (arm - P["brace_in"], -t), (t, -leg + P["brace_up"])
    mid = ((a[0] + b[0]) / 2 - P["bow"] * 0.7, (a[1] + b[1]) / 2 + P["bow"] * 0.7)
    corner = make_face([Line((t, -t), a), ThreePointArc(a, mid, b), Line(b, (t, -t))])
    k = P["brace_t"] / 2 ** 0.5
    window = fillet((corner & Pos(-k, k) * corner).vertices(), P["corner_r"])    # the same shape moved in by the brace
    arm_bar = Pos(arm / 2, -t / 2) * Rectangle(arm, t)
    leg_bar = Pos(t / 2, -leg / 2) * Rectangle(t, leg)
    profile = (fillet(arm_bar.vertices().group_by(Axis.X)[-1], P["tip_r"]) + fillet(leg_bar.vertices().group_by(Axis.Y)[0], P["tip_r"])
               + corner - window)
    body = extrude(profile, w)
    body = chamfer(body.edges().group_by(Axis.Z)[0] + body.edges().group_by(Axis.Z)[-1], P["edge"])

    # countersunk holes: head recess on the face the driver comes from
    hole_r, head_r = (P["screw_d"] + P["screw_clear"]) / 2, (P["screw_head_d"] + P["screw_clear"]) / 2
    screw = Cylinder(hole_r, 4 * t) + Cone(hole_r, head_r, P["screw_head_h"], align=(Align.CENTER, Align.CENTER, Align.MAX))
    for y in (-t - 16.0, -leg + 13.0):                         # into the wall: heads on the inside face of the leg
        body -= Pos(t, y, w / 2) * Rot(0, 90, 0) * screw
    for x in (t + 30.0, arm - 8.0):                            # up into the shelf: heads on the underside of the arm
        body -= Pos(x, -t, w / 2) * Rot(90, 0, 0) * screw
    return Pos(0, leg, 0) * body
