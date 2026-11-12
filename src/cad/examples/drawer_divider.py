"""Interlocking drawer divider grid (slotted strips that cross in half-laps)
Use for: dividing a drawer, box or shelf into compartments for cutlery, tools, socks or stationery; any grid of flat strips that slot together; flat parts cut to a measured space
Pattern: one function makes a strip from its length and slot count; every strip is a flat plate with rounded corners and half-depth slots with a lead-in; the set is laid out on the plate from the drawer's inside sizes, and "pose" stands it up as the grid
Modelled on: slotted plastic drawer divider strips, as in the 2 in high clip-and-strip sets (https://www.med-supply.net/products/divider-strip-only-2-inch)
Published sizes used: 2 in (50.8 mm) high x 21 1/4 in long = a bought strip (retailer listing, URL above), which is cut to the drawer; these are printed to length, so the drawer's inside length, width and height are the person's measurements
Concept: A grid that drops into a drawer and makes compartments. The long strips have slots cut down from the top edge and the cross strips have slots cut up from the bottom edge, each to half the height, so they cross flush like an egg crate and hold each other upright; the drawer's walls stop the grid sliding. Strips are 1 mm shorter than the drawer so they go in without bowing its sides. The slot is the strip thickness plus 0.3 mm: a hand push fit that still comes apart. Each strip is a plate, so it is drawn flat and extruded to its thickness, and printed lying down: the layers then run the length of the strip and it cannot split along its slots. 6 lines (2.4 mm) thick is stiff enough at 45 mm high. Measure the drawer at the bottom, where it is narrowest. PLA or PETG, no supports; a drawer longer than the bed needs each long strip in two halves butted at a cross strip.
What makes this good: it is sized from the three numbers a person can measure, every strip comes from one function, and the slots, not glue, do the holding.
"""
from build123d import *

P = {
    "drawer_l": 240.0,     # inside length of the drawer (the person's measurement)
    "drawer_w": 150.0,     # inside width
    "height": 45.0,        # strip height: a few mm under the drawer's inside height
    "long_strips": 2,      # strips running the length
    "cross_strips": 3,     # strips running the width
    "t": 2.4,              # strip thickness: 6 lines of 0.4
    "fit": 0.3,            # slot is this much wider than the strip
    "end_gap": 1.0,        # strips are this much shorter than the drawer
    "corner_r": 4.0,       # rounded top corners
    "lead_in": 1.2,        # flare at the mouth of each slot
    "gap_on_plate": 4.0,
    "pose": "plate",       # "plate": every strip lying flat, as printed; "assembled": the grid standing as it sits in the drawer
    "print_in_place": False,  # assembled, the strips sit in each other's slots at the fit: only touching is a problem
}


def strip(length, slots, from_top):
    """A flat strip lying on the bed, `slots` equally spaced half-depth slots cut from its top or bottom edge."""
    h, w = P["height"], P["t"] + P["fit"]
    plate = Rectangle(length, h)
    plate = fillet(plate.vertices().group_by(Axis.Y)[-1], P["corner_r"])       # top corners only: the bottom sits square
    edge = h / 2 if from_top else -h / 2
    inward = -1 if from_top else 1
    for i in range(slots):
        x = length * (i + 1) / (slots + 1) - length / 2
        cut = Pos(x, edge + inward * h / 4) * Rectangle(w, h / 2 + 0.6)         # 0.3 past half way, so the laps seat fully
        pts = [(x - w / 2 - P["lead_in"], edge), (x + w / 2 + P["lead_in"], edge), (x + w / 2, edge + inward * P["lead_in"] * 2),
               (x - w / 2, edge + inward * P["lead_in"] * 2)]
        plate -= cut + Polygon(*pts[::-inward], align=None)
    return Pos(0, h / 2) * extrude(plate, P["t"])


def build():
    long_l, cross_l = P["drawer_l"] - P["end_gap"], P["drawer_w"] - P["end_gap"]
    parts = [strip(long_l, P["cross_strips"], True) for _ in range(P["long_strips"])]
    parts += [strip(cross_l, P["long_strips"], False) for _ in range(P["cross_strips"])]
    if P["pose"] == "plate":
        step = P["height"] + P["gap_on_plate"]
        return Compound([Pos(-(long_l - s.bounding_box().size.X) / 2, i * step, 0) * s for i, s in enumerate(parts)])
    # assembled: stand each strip up (its Y becomes Z), long strips along X, cross strips along Y, each centred in its slot
    up = Rot(90, 0, 0) * Pos(0, 0, -P["t"] / 2)
    longs = [Pos(0, cross_l * (j + 1) / (P["long_strips"] + 1) - cross_l / 2, 0) * up * parts[j] for j in range(P["long_strips"])]
    crosses = [Pos(long_l * (i + 1) / (P["cross_strips"] + 1) - long_l / 2, 0, 0) * Rot(0, 0, 90) * up * parts[P["long_strips"] + i]
               for i in range(P["cross_strips"])]
    return Compound(longs + crosses)
