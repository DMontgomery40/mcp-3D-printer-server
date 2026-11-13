"""Stick-on desk-edge cable holder (five sprung slots in one small rail)
Use for: keeping several charging cables (USB-C, Lightning, earphone leads) side by side at a desk edge, bedside or shelf so the plugs do not fall behind; any multi-slot stick-on cable organiser
Pattern: a comb drawn in the plane its arms bend in: per slot, two tapered spring arms with round beads over a cradled seat, patterned along a base with rounded end blocks; extruded to the rail's depth and its outline chamfered
Modelled on: Orico CBS5 5-slot self-adhesive silicone desk cable holder (https://www.scom.hu/ORICO-CBS5-GY-Cable-Organizer-Grey)
Published sizes used: 96 x 20 x 12 mm = the bought holder's length, depth and height, for cables under 5 mm (retailer listing, URL above); this rigid one is shorter because its slots sit closer, and the slot sizes are design choices
Concept: A small rail taped to the desk top at its edge (or to the edge's front face) that parks five cables. Each cable is pushed down between two round beads into a seat a little bigger than itself: it slides freely, cannot lift out, and its plug is too big to pull back through, so the end stays on the desk. The bought one is soft silicone, which a printer cannot copy, so each slot has two thin arms that spring apart instead: 12 mm long and 3 lines thick at the tip, they let a 5 mm cable through the 3.2 mm mouth at about 1.6 percent strain, and the script prints that figure for whatever sizes it is given. It holds cables from 3.4 to 5.0 mm; a thinner one lifts out. The arms taper to the base so they bend along their length, not at the root, and the gaps beside them are what lets them move. This one is rightly an extrusion: it is printed standing on its front face, comb outline on the bed, so every arm bends within its layers and none can snap along a layer line; printed tape-face down the arms would be weak. No supports. PETG, 0.2 mm layers; 12.7 mm foam tape on the flat underside.
What makes this good: it is as small as the thing you buy (about 68 x 16 x 16 mm for five cables), with no clamp or screw, and the spring is drawn and printed in the plane it bends in.
"""
from build123d import *

P = {
    "slots": 5,
    "cable_max": 5.0,     # thickest cable it takes
    "seat_clear": 0.4,    # seat is this much bigger than cable_max so every cable slides
    "mouth": 3.2,         # gap between the beads; holds cables from about 3.4 mm
    "arm_tip_t": 1.26,    # arm thickness under the bead: 3 lines of 0.42
    "arm_root_t": 1.7,    # arm thickness at the base: the taper spreads the bending along the arm
    "pitch": 10.6,        # slot to slot
    "base_t": 3.0,        # base under the seats (the taped strip)
    "cradle": 1.0,        # the seat is sunk this far into the base
    "height": 16.0,       # underside to the top of the beads; taller means longer, easier arms
    "depth": 16.0,        # along the cable = height off the bed as printed; room for 12.7 mm tape
    "end_w": 7.0,         # solid block at each end
    "relief": 1.4,        # gap between the outer arms and the end blocks
    "edge": 0.6,          # chamfer round both faces of the comb: no sharp edge on a cable jacket
}

# What it is for, as data: cad_run compiles it into requirements and evaluates them on use() below.
PURPOSE = {
    "for": "an organizer that parks five charging cables at the edge of my desk so the plugs don't fall behind it",
    "modelled_on": "Orico CBS5 5-slot self-adhesive desk cable holder",
    "holds": [{"body": "cables", "mass_g": 40}],   # the five cable ends it carries, about 8 g each
    "mounts": [{"body": "desk", "by": "tape"}],
    "material": "PETG",
}


def build():
    seat_r = (P["cable_max"] + P["seat_clear"]) / 2
    h, tip, root_t = P["height"], P["arm_tip_t"], P["arm_root_t"]
    bead_r = (seat_r + tip - P["mouth"] / 2) / 2            # the bead spans from the mouth to the arm's outer face
    seat_y = P["base_t"] + seat_r - P["cradle"]             # seat centre
    half = (P["slots"] - 1) * P["pitch"] / 2 + seat_r + root_t + P["relief"] + P["end_w"]

    comb = Pos(0, P["base_t"] / 2) * Rectangle(2 * half, P["base_t"])
    for side in (-1, 1):                                    # end blocks, outer corners rounded
        block = Pos(side * (half - P["end_w"] / 2), h / 2) * Rectangle(P["end_w"], h)
        comb += fillet(block.vertices().sort_by(Axis.X)[2 if side > 0 else 0:][:2], P["end_w"] * 0.45)
    for i in range(P["slots"]):
        x = (i - (P["slots"] - 1) / 2) * P["pitch"]
        for side in (-1, 1):                                # one tapered arm and its bead; the inner face is straight
            pts = [(side * seat_r, 0), (side * (seat_r + root_t), 0), (side * (seat_r + tip), h - bead_r), (side * seat_r, h - bead_r)]
            arm = Polygon(*pts[::side], align=None)         # anticlockwise on both sides, so every face extrudes up
            comb += Pos(x, 0) * (arm + Pos(side * (P["mouth"] / 2 + bead_r), h - bead_r) * Circle(bead_r))
        comb -= Pos(x, seat_y) * Circle(seat_r)             # the cradle in the base

    # the spring, worked out: each arm is a cantilever from the base to its bead, pushed out by half of (cable - mouth)
    arm_len = h - bead_r - P["base_t"]
    t_base = root_t - (root_t - tip) * P["base_t"] / (h - bead_r)
    strain = 1.5 * t_base * (P["cable_max"] - P["mouth"]) / 2 / arm_len ** 2
    print(f"arm strain while the thickest cable passes the mouth: {100 * strain:.1f} % (keep to about 2 % for PETG)")

    rail = extrude(comb, P["depth"])
    return chamfer(rail.edges().group_by(Axis.Z)[0] + rail.edges().group_by(Axis.Z)[-1], P["edge"])


def use():
    """As used: the taped base on the desk top (Z = 0), a 4 mm cable lying in each seat. cad_run computes the tape's
    load from this, so the rail's size is checked against what it carries, not asserted."""
    seat_r = (P["cable_max"] + P["seat_clear"]) / 2
    rail = Rot(90, 0, 0) * build()                           # the comb's up (Y) becomes Z; its depth runs along -Y
    rail.label = "rail"
    z = P["base_t"] - P["cradle"] + 2.0                      # a 4 mm cable resting in the bottom of its seat
    cables = Compound([Pos((i - (P["slots"] - 1) / 2) * P["pitch"], -P["depth"] / 2, z) * (Rot(90, 0, 0) * Cylinder(2.0, 60))
                       for i in range(P["slots"])])
    cables.label = "held:cables"
    desk = Pos(0, -P["depth"] / 2, -10) * Box(300, 200, 20)
    desk.label = "world:desk"
    return Compound(children=[rail, cables, desk])
