"""Wall-mounted spring grip for a broom or mop handle (one screw, snap-in C with flared lips)
Use for: storing a broom, mop, rake, torch or any round handle or pipe 19 to 29 mm thick on a wall or inside a cupboard door; any snap-in spring clip that grips a round bar
Pattern: sweep one rounded section round the handle's axis for the C ring; pad and lip beads as simple bodies chamfered before they are joined; one countersunk screw through the seat, reached through the mouth
Modelled on: National Hardware spring grip clips for handles (https://www.doitbest.com/product/222143/national-rust-resistant-spring-grip-clip-hook-222143/); screw is SPAX 4.0 mm flat countersunk (https://www.ahlsell.se/en/products/mounting/wood-screw/wood-screw-spax/71333788---traskruv-tft-spax-svart-4.0x25h-200fp-eta-120114)
Published sizes used: 3/4 to 1 1/8 in (19 to 28.6 mm) = handle diameters the bought steel clip takes (retailer listing, first URL); 4.0 mm = screw thread, 8.0 mm = head diameter, 2.4 mm = head height (SPAX listing, second URL); ring, wall and mouth sizes are design choices
Concept: A clip on the wall that a broom handle is pushed into and pulled out of with one hand. Frame: the wall is the plane y = 0 and the mouth faces away from it, towards -y (the front view). The handle spreads two arms as it passes the mouth and they close behind it; the ring is made 1 mm smaller than the handle so it keeps squeezing and the broom does not slide down. The bought clip is spring steel; plastic arms must be longer and thicker to do the same job, so the ring wraps 230 degrees and the arms are 4 lines (1.68 mm) thick: opening the 20 mm mouth to a 25 mm handle strains them about 2 percent, and the script prints that figure for whatever sizes it is given. Round beads on the lips guide the handle in and are kind to its paint. The screw sits in the seat, where the handle covers it, and pulls the pad flat to the wall. It is printed with the C outline on the bed, the handle's axis upright, so the arms bend within their layers; printed lying on the pad they would split along a layer the first time. No supports. PETG (PLA arms creep open in a warm cupboard), 4 walls.
What makes this good: it is sized as a spring, not as a bracket, with the strain worked out in the script, and the one screw is hidden under the handle.
"""
from math import acos, asin, degrees, radians

from build123d import *

P = {
    "handle_d": 25.0,       # the handle it grips (inside the published 19 to 28.6 mm range)
    "squeeze": 1.0,         # ring is this much smaller than the handle, so it grips
    "mouth": 20.0,          # gap between the beads, 80% of the handle
    "arm_t": 1.68,          # ring wall: 4 lines of 0.42, thin enough to spring
    "bead_r": 1.6,          # round bead on the end of each arm: lead-in outside, retaining bump inside
    "pad_over": 1.0,        # the pad stands this far above the seat; lower leaves more arm free to bend
    "height": 22.0,         # along the handle = height off the bed as printed
    "pad_w": 34.0,          # wall pad width
    "pad_t": 5.0,           # wall to the seat; leaves 2.6 mm under the screw head
    "screw_d": 4.0,         # screw thread diameter (published)
    "screw_head_d": 8.0,    # head diameter (published)
    "screw_head_h": 2.4,    # head height (published)
    "screw_clear": 0.5,
    "edge": 0.8,            # softening of the ring's, beads' and pad's edges
}


def build():
    h, e = P["height"], P["edge"]
    r_in = (P["handle_d"] - P["squeeze"]) / 2
    r_mid = r_in + P["arm_t"] / 2
    yc = P["pad_t"] + r_in                                    # ring centre: the seat is pad_t from the wall
    half = degrees(asin((P["mouth"] / 2 + P["bead_r"]) / r_mid))   # half the mouth angle: the beads end up `mouth` apart
    up = (Align.CENTER, Align.CENTER, Align.MIN)

    # each piece is a simple body with its own softened edges, then they are joined: an outline chamfered after the
    # union fails here. The ring is one section swept round the handle's axis, open at the mouth.
    arc = Pos(0, yc, h / 2) * CenterArc((0, 0), r_mid, 90 + half, 360 - 2 * half)
    ring = sweep(Plane(arc @ 0, x_dir=(0, 0, 1), z_dir=arc % 0) * RectangleRounded(h, P["arm_t"], e), path=arc)
    bead = Cylinder(P["bead_r"], h, align=up)
    bead = chamfer(bead.edges(), e)                           # lead-in outside the arm, retaining bump inside it
    pad_y = P["pad_t"] + P["pad_over"]
    pad = Pos(0, pad_y / 2, 0) * Box(P["pad_w"], pad_y, h, align=up)
    pad = fillet(pad.edges().filter_by(Axis.Z).filter_by_position(Axis.Y, 1, 99), 3.0)   # round the two front corners in plan
    pad = chamfer(pad.edges().group_by(Axis.Z)[0] + pad.edges().group_by(Axis.Z)[-1], e)
    grip = ring + pad + [Pos(arc @ u) * Pos(0, 0, -h / 2) * bead for u in (0, 1)]
    grip -= Pos(0, yc, 0) * Cylinder(r_in, h, align=up)       # the seat, cleared through the pad

    # the spring, worked out: each arm is a cantilever from where the ring leaves the pad round to its bead,
    # and the handle pushes each bead out by half of (handle - mouth)
    free = radians(180 - half) - acos((r_in - P["pad_over"]) / (r_in + P["arm_t"]))
    strain = 1.5 * P["arm_t"] * (P["handle_d"] - P["mouth"]) / 2 / (r_mid * free) ** 2
    print(f"arm strain while the handle passes the mouth: {100 * strain:.1f} % (keep to about 2 % for PETG)")

    hole_r, head_r = (P["screw_d"] + P["screw_clear"]) / 2, (P["screw_head_d"] + P["screw_clear"]) / 2
    screw = Cylinder(hole_r, 4 * P["pad_t"]) + Cone(hole_r, head_r, P["screw_head_h"], align=(Align.CENTER, Align.CENTER, Align.MAX)) \
        + Cylinder(head_r, 6, align=(Align.CENTER, Align.CENTER, Align.MIN))       # head recess clear up into the seat
    return Rot(0, 0, 180) * (grip - Pos(0, P["pad_t"], h / 2) * Rot(-90, 0, 0) * screw)   # mouth towards the front view
