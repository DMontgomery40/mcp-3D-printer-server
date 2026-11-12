"""Screw-top jar and lid with a standard 70-400 neck
Use for: a jar, tub or canister with a screw lid; any printed screw thread, cap or threaded collar
Pattern: revolve a wall profile for the body, sweep a thread section along a helix for the screw thread (same pitch on both parts, clearance as a radial offset), pattern a cutter round the lid for grip
Modelled on: wide-mouth jars with a GPI/SPI 70-400 continuous-thread finish (https://www.ebottles.com/blogs/articles/guide-for-fitting-closures-on-bottles)
Published sizes used: 70-400 finish, converted from the chart's inches: T (thread outside diameter) 68.61 to 69.49 mm; E (neck at the thread root) 66.22 to 67.11 mm; H (finish height) 9.98 to 10.74 mm; S (rim to thread start) 0.79 to 1.55 mm; 6 threads per inch = 4.233 mm pitch; thread depth (T - E)/2 = 1.19 mm (retailer's chart of the standard, URL above). The thread's flank angle is not in the chart: 45 degree flanks are a choice made so it prints.
Concept: A jar whose lid screws on in one turn. The neck is the standard 70-400 finish, so the printed lid also fits bought 70 mm jars and a bought cap fits this jar, give or take the printer. One turn of thread on the neck pulls the lid down until its inside face seats on the rim: the thread only holds the joint shut, the rim takes the squeeze. Both threads are the same section swept along the same helix; the lid's is moved outwards by the clearance, never scaled, so the pitch matches at every turn. The body is one revolved wall: a rounded floor corner (no stress line, easy to wipe out), a shoulder at 45 degrees so it prints without supports, a rolled rim. The lid has a domed edge and 24 finger scallops. Both print upright as modelled, jar on its floor and lid on its top face, opening up; the thread flanks are 45 degrees. PETG or PLA, 3 walls; not for food unless the filament and printer are.
What makes this good: a real standard interface, a thread made the way threads are made (one section along a helix), and every wall a single revolved curve.
"""
import math
from build123d import *

P = {
    "T": 69.0,             # thread outside diameter (70-400: 68.61 to 69.49)
    "E": 66.6,             # neck diameter at the thread root (66.22 to 67.11)
    "H": 10.4,             # finish height, rim to shoulder (9.98 to 10.74)
    "S": 1.2,              # rim down to where the thread starts (0.79 to 1.55)
    "pitch": 4.233,        # 6 threads per inch
    "turns": 1.0,          # a 400 finish has one turn of thread
    "crest": 1.0,          # width of the thread's crest; flanks at 45 degrees from there
    "body_d": 82.0,        # jar body outside diameter
    "body_h": 58.0,        # floor to shoulder top
    "wall": 2.0,           # jar and lid wall
    "floor": 2.4,
    "corner": 8.0,         # radius of the floor corner
    "fit": 0.35,           # radial clearance between the two threads (print allowance)
    "lid_top": 2.4,
    "scallops": 24,        # finger scallops round the lid
    "gap_on_plate": 12.0,  # space between jar and lid as laid out
}

def thread(root_r, crest_r, z0):
    """One thread: a 45 degree trapezoid swept along a helix. root_r may be larger than crest_r (the lid's thread)."""
    depth = crest_r - root_r
    half_root = P["crest"] / 2 + abs(depth)                      # 45 degree flanks
    bury = 0.4 * (1 if depth > 0 else -1)                         # sink the root into the wall so the union is clean
    section = Polygon((root_r - bury, -half_root - 0.4), (crest_r, -P["crest"] / 2), (crest_r, P["crest"] / 2), (root_r - bury, half_root + 0.4), align=None)
    path = Helix(P["pitch"], P["pitch"] * P["turns"], (root_r + crest_r) / 2)
    return Pos(0, 0, z0) * sweep(Plane.XZ * section, path=path, is_frenet=True)

def build():
    w, R, top = P["wall"], P["body_d"] / 2, P["body_h"] + P["H"]
    neck_r = P["E"] / 2
    # jar: one closed wall section in the XZ plane, revolved; the shoulder rises at 45 degrees to the neck
    shoulder_z = P["body_h"] - (R - neck_r)
    outer = Polyline((0, 0), (R, 0), (R, shoulder_z), (neck_r, P["body_h"]), (neck_r, top), (neck_r - w, top),
                     (neck_r - w, P["body_h"] - 0.8), (R - w, shoulder_z - 0.8), (R - w, P["floor"]), (0, P["floor"]), close=True)
    wall = make_face(outer)
    wall = fillet(wall.vertices().filter_by_position(Axis.Y, -0.1, P["floor"] + 0.1).filter_by_position(Axis.X, R - w - 0.1, R + 0.1), P["corner"] / 2)
    jar = revolve(Plane.XZ * wall, Axis.Z)
    z_thread = top - P["S"] - (P["crest"] / 2 + (P["T"] - P["E"]) / 2) - P["pitch"] * P["turns"]
    jar += thread(neck_r, P["T"] / 2, z_thread)

    # lid: a cup over the neck, opening up as printed; its thread is the same helix moved out by the fit
    lid_in = P["T"] / 2 + P["fit"]
    lid_out = lid_in + w
    lid_h = P["lid_top"] + P["H"] - 1.0
    cup = Cylinder(lid_out, lid_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    cup = fillet(cup.edges().group_by(Axis.Z)[0], 1.6)                              # the domed edge, on the bed
    cup -= Pos(0, 0, P["lid_top"]) * Cylinder(lid_in, lid_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    scallop = Pos(lid_out + 2.2, 0, 0) * Cylinder(3.0, lid_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    cup -= [Rot(0, 0, i * 360 / P["scallops"]) * scallop for i in range(P["scallops"])]
    lid = cup + Pos(0, 0, 0) * thread(lid_in, neck_r + P["fit"], P["lid_top"] + P["S"] + 0.6)
    return Compound([jar, Pos(R + lid_out + P["gap_on_plate"], 0, 0) * lid])
