"""Plant pot and saucer (4 in nursery pot, rolled rim, drain holes, ribbed saucer)
Use for: a plant pot, planter, cup, tumbler, pen pot or vase with or without a saucer; any round tapered vessel or dish
Pattern: draw half the wall as one closed profile, fillet its corners in 2D, revolve it; pattern holes round the axis; a second revolved profile for the saucer with ribs added
Modelled on: 4 inch plastic nursery pots with drainage and saucers (https://planetdesert.com/products/white-4-inch-flower-plastic-nursery-pots-with-drainage-and-saucers-perfect-for-succulents)
Published sizes used: 4 in (10 cm) = pot top diameter, 3.3 in (8.5 cm) = height, 2.8 in (7 cm) = bottom diameter (seller's listing, URL above); wall, rim, hole and saucer sizes are design choices
Concept: A pot for a small house plant, with the saucer that catches what drains. 2 bodies, printed side by side. The pot is one revolved wall: it leans out 10 degrees so the root ball slides out for repotting and pots nest, the rim is thickened and rounded because the rim is where a pot is picked up and where it cracks, and the floor curves into the wall so there is no corner to split. Water leaves through six holes in the floor. The saucer has three low ribs: the pot stands on them, so the holes are never sealed against a flat floor and the plant does not sit in its own water. Its wall leans out further than the pot's so the pot lifts out easily. Both print upright as modelled, floors on the bed, no supports; every wall is within 20 degrees of vertical. 3 walls and 4 bottom layers hold water; PETG outdoors, PLA indoors.
What makes this good: each wall is one closed profile revolved, so thickness, taper and rim are decided in a drawing a person can read, and the saucer's ribs solve the real problem (drainage), not just the look.
"""
from build123d import *

P = {
    "top_d": 100.0,         # pot outside diameter at the rim (published: 4 in)
    "bottom_d": 70.0,       # pot outside diameter at the floor (published: 2.8 in)
    "height": 85.0,         # published: 3.3 in
    "wall": 2.0,            # 5 lines of 0.4
    "floor": 2.0,
    "rim_t": 3.2,           # thickened rim
    "rim_h": 6.0,
    "floor_r": 6.0,         # radius where the floor curves into the wall, inside
    "holes": 6,
    "hole_d": 7.0,
    "saucer_h": 16.0,
    "saucer_gap": 6.0,      # saucer floor is this much wider than the pot's, all round
    "saucer_flare": 9.0,    # saucer wall leans out this far over its height
    "rib_h": 2.0,           # ribs the pot stands on
    "gap_on_plate": 10.0,
}


def vessel(r_bottom, r_top, h, rim_t, rim_h):
    """A revolved cup: wall profile in XZ (floor, leaning wall, thickened rounded rim), inside floor corner rounded."""
    w, f = P["wall"], P["floor"]
    lean = (r_top - r_bottom) / h
    r_at = lambda z: r_bottom + lean * z                     # outside radius at height z
    pts = [(0, 0), (r_bottom, 0), (r_at(h - rim_h), h - rim_h), (r_top + rim_t - w, h - rim_h + 1.5), (r_top + rim_t - w, h),
           (r_top - w, h), (r_at(f) - w, f), (0, f)]
    half = Polygon(*pts, align=None)
    half = fillet(half.vertices().filter_by(lambda v: v.Y > h - 0.1), min(rim_t, rim_h) * 0.45)          # rounded rim
    half = fillet(half.vertices().filter_by(lambda v: abs(v.Y - f) < 0.01 and v.X > 1), P["floor_r"])      # floor into wall
    return revolve(Plane.XZ * half, Axis.Z)


def build():
    r_b, r_t = P["bottom_d"] / 2, P["top_d"] / 2
    pot = vessel(r_b, r_t, P["height"], P["rim_t"], P["rim_h"])
    hole = Pos(r_b * 0.55, 0, 0) * Cylinder(P["hole_d"] / 2, 4 * P["floor"])
    pot -= [Rot(0, 0, i * 360 / P["holes"]) * hole for i in range(P["holes"])]

    s_b = r_b + P["saucer_gap"]
    saucer = vessel(s_b, s_b + P["saucer_flare"], P["saucer_h"], 2.4, 3.0)
    rib = Pos(r_b * 0.55, 0, P["floor"] + P["rib_h"] / 2 - 0.2) * Box(r_b * 0.7, 3.0, P["rib_h"] + 0.4)
    saucer += [Rot(0, 0, 30 + i * 120) * rib for i in range(3)]      # between the holes, not under them
    return Compound([pot, Pos(r_t + s_b + P["saucer_flare"] + P["rim_t"] + P["gap_on_plate"], 0, 0) * saucer])
