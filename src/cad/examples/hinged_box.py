"""Hinged pill and parts box with a snap latch, printed in place
Pattern: model the lid CLOSED on the box, then swing it 180 degrees about the pin axis into the flat printed pose; hull-profile knuckles with cone pin ends cut as cone sockets
Modelled on: rose plastic UniBox, a polypropylene hinged box with a press closure (https://shop.rose-plastic.de/en_10/plastic-boxes/unibox.html; the page lists no box this small, the smallest read was 100 x 100 mm inside)
Published sizes used: none published; sizes are design choices
Concept: A pocket box for pills or small screws, in 2 bodies: the box (two outer hinge knuckles, the latch spring) and the lid (centre knuckle, locating lip, thumb finger). It is printed open and flat, box and lid side by side with the knuckles between them, because that is the only pose in which both halves stand on the bed with their open sides up, so nothing inside needs support and the hinge prints with a clean gap; it comes off the bed as one working piece. That layout fixes the pin at half the closed height. The lid knuckle ends in a 45 degree cone each side, seated in a cone socket in the box knuckles with 0.4 mm all round, so the pin is captive as printed and its overhangs never pass 45 degrees. Closed, the lid's lip drops inside the box mouth and takes side knocks; the hinge side has no lip because the hinge already locates that edge. The latch is a leaf spring 3 lines (1.26 mm) wide standing along the front wall, bending in the layer plane, with the wall 0.9 mm behind it as its hard stop: the barb on the lid's finger cams the leaf in 0.5 mm and snaps under its nose, and the 45 degree catch faces let a firm pull, or a press on the leaf, open it. PETG or PLA, 0.2 mm layers, no supports.
What makes this good: it is drawn closed, where the fits are easy to reason about, and one rotation about the pin gives the printable pose, so the closed fit and the printed gaps cannot disagree.
"""
from build123d import *
from math import sqrt

P = {
    "length": 60.0,       # along the hinge (Y), outside
    "width": 40.0,        # hinge side to latch side (X), outside
    "box_h": 14.0,        # box height including the floor
    "lid_h": 6.0,         # lid height including its top
    "wall": 1.6,          # walls, floor and lid top: 4 lines of 0.4
    "corner_r": 6.0,      # plan corner radius, comfortable in a pocket
    "edge_r": 1.5,        # rounded floor edge and lid top edge (small enough to print on the bed)
    "scoop_r": 3.0,       # fillet inside the floor so a fingertip can sweep a pill out
    "lip_h": 1.6,         # how far the lid's lip drops into the box
    "lip_t": 1.2,         # lip thickness: 3 lines
    "lip_fit": 0.25,      # lip to box wall, each side
    "gap": 0.4,           # print-in-place clearance, hinge faces and cones
    "hinge_off": 4.5,     # pin axis to the back walls
    "knuckle_r": 3.0,     # knuckle outer radius
    "pin_r": 2.0,         # cone pin radius at its root
    "pin_tip_r": 0.6,     # cone pin radius at its flat tip
    "box_knuckle": 8.0,   # length of each of the box's two knuckles
    "lid_knuckle": 16.0,  # length of the lid's centre knuckle
    "leaf_t": 1.26,       # latch leaf spring: 3 lines of 0.42, bends in the layer plane
    "leaf_len": 16.0,     # free length of the leaf (0.9 mm at the tip strains it under 1 percent)
    "stop_gap": 0.9,      # leaf to front wall: the wall is the hard stop
    "nose": 0.8,          # how far the leaf's nose stands out
    "catch": 0.5,         # overlap of nose and barb = the stroke to open
    "latch_play": 0.2,    # vertical play between the catch faces when shut
    "latch_w": 8.0,       # width of the nose; the finger is 2 mm wider
    "finger_t": 2.4,      # thickness of the lid's thumb finger
}

def rect(x0, x1, y0, y1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * Rectangle(x1 - x0, y1 - y0)

def plan(inset=0.0):  # the rounded footprint, shared by box, cavity, lid and lip
    return RectangleRounded(P["width"] - 2 * inset, P["length"] - 2 * inset, P["corner_r"] - inset)

def knuckle(za, z0, z1, y_len):  # round eye on the pin axis, hulled to the face of its own wall between z0 and z1
    d = P["hinge_off"]
    eye = Pos(0, za) * Circle(P["knuckle_r"])
    web = make_hull(eye.edges() + rect(-d, -d + 0.1, z0, z1).edges()) + rect(-d - P["wall"] / 2, -d, z0, z1)   # second term keys it into the wall
    return extrude(Plane.XZ * web, y_len / 2, both=True)

def pin_end(za, grow):  # 45 degree cone along +Y from the lid knuckle's end face; grow > 0 makes the socket `grow` larger all round
    r, tip = P["pin_r"], P["pin_tip_r"]
    cone = Cone(r + grow * sqrt(2), tip + grow * (sqrt(2) - 1), r - tip + grow, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return Pos(0, P["lid_knuckle"] / 2, za) * Rot(-90, 0, 0) * cone

def build():
    W, hb, hl, t, gap, d = P["width"], P["box_h"], P["lid_h"], P["wall"], P["gap"], P["hinge_off"]
    za = (hb + hl) / 2                                 # pin height: half the closed height, so the opened lid lands on the bed
    lo = za - d - P["knuckle_r"] * sqrt(2)             # lowest wall point a knuckle web may reach and still rise at 45 degrees
    at_box = Pos(-(d + W / 2), 0, 0)                   # the pin axis is the Y axis at height za; the box sits on its -X side
    swing_open = Pos(0, 0, za) * Rot(0, 180, 0) * Pos(0, 0, -za)

    # box: rounded shell with a scooped floor, two outer knuckles with cone sockets
    shell = extrude(plan(), hb)
    shell = fillet(shell.edges().group_by(Axis.Z)[0], P["edge_r"])
    cavity = extrude(Pos(0, 0, t) * plan(t), hb)
    shell -= fillet(cavity.edges().group_by(Axis.Z)[0], P["scoop_r"])
    box_k = Pos(0, (P["lid_knuckle"] + P["box_knuckle"]) / 2 + gap, 0) * knuckle(za, lo, hb, P["box_knuckle"]) - pin_end(za, gap)
    box = at_box * shell + box_k + mirror(box_k, Plane.XZ)

    # lid, drawn closed on top of the box: cap, lip hanging into the mouth (not on the hinge side), centre knuckle with cone ends
    cap = extrude(Pos(0, 0, hb) * plan(), hl)
    cap = fillet(cap.edges().group_by(Axis.Z)[-1], P["edge_r"])
    a = t + P["lip_fit"]
    lip = extrude(Pos(0, 0, hb - P["lip_h"]) * plan(a), P["lip_h"])
    lip -= Pos(W / 2, 0, hb - P["lip_h"] / 2) * Box(2 * P["corner_r"], P["length"], P["lip_h"])   # a lip here would swing through the back wall
    hollow = extrude(Pos(0, 0, hb - P["lip_h"]) * plan(a + P["lip_t"]), P["lip_h"] + hl - t)
    lid_k = knuckle(za, hb, 2 * za - lo, P["lid_knuckle"]) + pin_end(za, 0) + mirror(pin_end(za, 0), Plane.XZ)
    lid = at_box * (cap + lip - hollow) + lid_k

    # latch, in the closed pose. out(x, z) is a point x outside the front wall at height z.
    xf = -(d + W)
    out = lambda x, z: (xf - x, z)
    face, zt, half = P["stop_gap"] + P["leaf_t"], hb - gap, P["latch_w"] / 2     # leaf outer face; leaf top, clear of the finger above it
    tip = face + P["nose"]                                                       # nose tip
    zn = zt - 1.5 * P["nose"] - gap                                              # bottom of the nose's flat tip
    leaf = rect(xf - face, xf - P["stop_gap"], half - P["leaf_len"], half)       # stands on the bed, free at +Y
    root = rect(xf - face, xf + t / 2, half - P["leaf_len"] - 2 * P["leaf_t"], half - P["leaf_len"])
    nose = Polygon(out(face - 0.2, zt), out(face, zt), out(tip, zt - 1.5 * P["nose"]), out(tip, zn), out(face - 0.2, zn - P["nose"] - 0.2), align=None)
    box += extrude(leaf + root, zt) + extrude(Plane.XZ * nose, half, both=True)  # nose underside is 45 degrees: catch face, and printable

    fi, b = tip + gap, P["catch"] + gap                # finger inner face clears the nose tip; barb reaches `catch` under the nose
    zc = zn + P["latch_play"]                          # top of the barb's 45 degree catch face, parallel to the nose's
    zb = zc - b - gap                                  # bottom of the barb's flat tip; the lead-in ramp runs down from here
    finger = Polygon(out(-t / 2, hb), out(fi, hb), out(fi, zc), out(fi - b, zc - b), out(fi - b, zb), out(fi, zb - 1.5 * b),
                     out(fi + P["finger_t"], zb - 1.5 * b), out(fi + P["finger_t"], hb + hl), out(-t / 2, hb + hl), align=None)
    finger = extrude(Plane.XZ * finger, half + 1, both=True)
    lid += fillet(finger.edges().filter_by(Axis.Z).group_by(Axis.X)[0], 1.0)     # soft corners where the thumb lifts

    return Compound([box, swing_open * lid])
