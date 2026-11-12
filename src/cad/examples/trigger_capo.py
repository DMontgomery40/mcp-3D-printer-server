"""Trigger capo for a steel-string acoustic guitar
Pattern: two rigid levers on one pivot with a printed hairpin spring; each profile drawn in the plane it bends in, extruded, edges chamfered; one script gives the assembled pose and the print plate
Modelled on: Kyser Quick-Change KG6 (https://kysermusical.com/products/acoustic-guitar-capo) and Dunlop Trigger 83CB (https://www.jimdunlop.com/37083002001-trigger-capo-acoustic/)
Published sizes used: 44.45 mm = Martin D-28 fingerboard width at the nut, 53.98 mm at the 12th fret (maker, https://www.martinguitar.com/guitars/standard-series/D-28.html), so 48 mm where a capo sits; 406.4 mm (16 in) = the D-28's published saddle radius, used for the bar's curve (maker, same page; the fingerboard radius itself is not on it); 29 to 74 N = clamp force measured on bought spring capos, too little buzzes and too much pulls sharp (G7th, https://www.g7th.com/force-testing-at-sheehans); 4.5 mm = M4 clearance hole (ISO 273 medium). The neck depth (23.5 mm, string tops to the back of the neck) is not published by the maker: measure the guitar.
Concept: A capo is a spring clamp that frets all six strings at once, put on and taken off with one hand. This is the trigger kind every shop sells: two rigid levers on one pivot beside the neck. The upper lever's bar lies across the strings (curved to the fingerboard, thickest at its root where the bending is greatest) and the lower lever curls round the back of the neck to a cradle under its centre; both jaws carry a 2 mm soft pad, because bare plastic buzzes on strings and marks lacquer. Their tails are the handles: squeezing them opens the jaws, and a hairpin spring printed as part of the lower lever pushes them apart again. Load path: spring, handles, pivot screw, jaws, pads, strings and neck. The spring's two 2.94 mm legs bend in the print plane; standing 18 degrees open off the guitar it is unstrained, on the neck it gives about 34 N at the strings at about 1.5 % strain, and fully open about 2.9 % for a moment (beam estimate, PETG, E about 2000 MPa: not a measurement). Each lever prints flat on its side, so every layer runs the length of the lever and the spring; the levers are halved at the pivot (a half-lap) so both lie flat with no supports, the upper one turned over. PETG, 4 walls. Add an M4 x 20 screw with a self-locking nut, and two pads (TPU, or self-adhesive silicone strip). Take it off the guitar when you stop playing: held bent, PETG slowly relaxes.
What makes this good: it is the product (two levers, a pivot, a spring, pads, handles a hand can squeeze) with every part drawn in the plane it bends in, and it rests unstrained.
"""
import math
from build123d import *

P = {
    "pose": "assembled",        # "assembled": clamped on the neck, standing as used; "plate": both arms flat, as printed
    "neck_width": 48.0,         # fingerboard width where the capo sits (frets 1 to 7)
    "neck_depth": 23.5,         # string tops to the back of the neck there
    "board_radius": 406.4,      # fingerboard radius (16 in)
    "width": 16.0,              # capo width along the neck = print height of each arm
    "pad": 2.0,                 # soft pad on both jaws (TPU, or a bought silicone strip)
    "bar_tip": 6.0,             # string bar thickness at its free end
    "bar_root": 10.0,           # and at its root, where the bending moment is greatest
    "arm": 8.0,                 # thickness of the neck arm and the handles
    "pivot_out": 17.0,          # pivot centre: this far outside the bass edge of the fingerboard
    "pivot_down": 9.0,          # and this far below the string tops
    "pivot_d": 4.5,             # clearance hole for an M4 screw (ISO 273, medium)
    "lug_r": 8.0,               # pivot lug radius
    "handle": 54.0,             # handle length from the pivot
    "handle_deg": 30.0,         # each handle's angle from the horizontal, clamped
    "spring_t": 2.94,           # hairpin leg thickness: 7 lines of 0.42
    "spring_set": 18.0,         # degrees the free spring stands open beyond its seat: gives the clamp force
    "edge": 1.2,                # chamfer on every long edge a hand or the guitar touches
    "gap": 0.3,                 # clearance between the arms at the pivot, and under each pad
}

def polar(c, r, deg):
    return (c[0] + r * math.cos(math.radians(deg)), c[1] + r * math.sin(math.radians(deg)))

def stroke(curve, w):           # a curve given width, with round ends
    return trace(curve, w) + Pos((curve @ 0).X, (curve @ 0).Y) * Circle(w / 2) + Pos((curve @ 1).X, (curve @ 1).Y) * Circle(w / 2)

def build():
    W, pad, half, arm, H, g = P["neck_width"], P["pad"], P["neck_width"] / 2, P["arm"], P["width"], P["gap"]
    piv = (W + P["pivot_out"], -P["pivot_down"])
    sag = P["board_radius"] - math.sqrt(P["board_radius"] ** 2 - half ** 2)     # the fingerboard's crown
    lug = Pos(*piv) * Circle(P["lug_r"])

    # upper arm: string bar (thickest at its root), shoulder down to the pivot, handle up and out
    x0, x1 = -3.0, W + 3.0
    under = ThreePointArc((x0, pad - sag), (half, pad), (x1, pad - sag))        # follows the fingerboard radius
    over = Spline((x1, pad + P["bar_root"]), (half, pad + (P["bar_tip"] + P["bar_root"]) / 2 + 0.8), (x0, pad + P["bar_tip"]))
    bar = make_face([under, Line(under @ 1, over @ 0), over, Line(over @ 1, under @ 0)])
    bar = fillet(bar.vertices().sort_by(Axis.X)[:2], 2.5)                        # round the free tip
    shoulder = stroke(Spline((x1 - 5, pad + P["bar_root"] / 2), (x1 + 5, pad + 2), piv), P["bar_root"])
    up_tip = polar(piv, P["handle"], P["handle_deg"])
    upper = bar + shoulder + lug + stroke(Spline(piv, polar(piv, P["handle"] * 0.5, P["handle_deg"] + 6), up_tip), arm) + Pos(*up_tip) * Circle(arm * 0.8)

    # lower arm: an elliptical C round the back of the neck to a cradle under its centre, handle down and out
    cx, cy = half, -2.5
    a, b = half + 3.0 + arm / 2, P["neck_depth"] + cy + pad + arm / 2            # the C's centre line
    ell = lambda t, da=0.0: (cx + (a + da) * math.cos(math.radians(t)), cy + (b + da) * math.sin(math.radians(t)))
    lo_tip = polar(piv, P["handle"], -P["handle_deg"])
    lower = stroke(Spline(piv, *[ell(t) for t in range(-30, -119, -11)]), arm) + lug
    lower += stroke(Spline(piv, polar(piv, P["handle"] * 0.5, -P["handle_deg"] - 6), lo_tip), arm) + Pos(*lo_tip) * Circle(arm * 0.8)

    # hairpin spring, part of the lower arm, in the wedge between the handles: from the lower handle's tip in
    # towards the pivot, round a bend, and out to bear under the upper handle. Both legs bend in the print plane.
    t, rb = P["spring_t"], 6.0
    bend = polar(piv, 28.0, 0)
    seat_deg = P["handle_deg"] - math.degrees(math.asin((arm / 2 + t / 2 + g) / (P["handle"] - 8)))
    open_deg = P["spring_set"] if P["pose"] == "plate" else 0.0                   # free shape on the plate, seated when assembled
    root = polar(piv, P["handle"] - 2, -P["handle_deg"] + 4)
    nose = polar(piv, P["handle"] - 8, seat_deg + open_deg)
    lo_b, up_b = polar(bend, rb, -90), polar(bend, rb, 90 + open_deg)
    hairpin = stroke(Line(root, lo_b), t) + stroke(ThreePointArc(lo_b, polar(bend, rb, 180 + open_deg / 2), up_b), t) + stroke(Line(up_b, nose), t)

    # solids: extrude, round the long edges, then halve each arm at the pivot (a half-lap) so both print flat
    hole = Pos(*piv) * Circle(P["pivot_d"] / 2)
    lap = Pos(*piv) * Circle(P["lug_r"] + 5.0)
    def solid(sketch, keep_low, spring=None):
        body = extrude(sketch - hole, H)
        # break both faces' edges with a chamfer: on an outline built from many curves a chamfer always succeeds
        # where OCCT's fillet often fails, and on the bed face it also takes up the first layer's flare
        body = chamfer(body.edges().group_by(Axis.Z)[0] + body.edges().group_by(Axis.Z)[-1], P["edge"])
        if spring:              # the spring keeps square edges: it is thinner than two chamfers
            body += extrude(spring, H)
        cut = extrude(lap, H / 2 + g / 2 + 1)
        return body - (Pos(0, 0, H / 2 - g / 2) * cut if keep_low else Pos(0, 0, -1) * cut)
    upper3, lower3 = solid(upper, False), solid(lower, True, hairpin)

    if P["pose"] == "plate":    # as printed: each arm on its side, the upper one turned over so its half-lap is on the bed
        return Compound([lower3, Pos(0, 50, H) * Rot(180, 0, 0) * upper3])
    # soft pads, shown in place: under the bar on the strings, and in the cradle on the back of the neck
    string_pad = make_face([ThreePointArc((x0 + 1, -sag), (half, 0), (x1 - 1, -sag)), Line((x1 - 1, -sag), (x1 - 1, pad - sag - g)),
                            ThreePointArc((x1 - 1, pad - sag - g), (half, pad - g), (x0 + 1, pad - sag - g)), Line((x0 + 1, pad - sag - g), (x0 + 1, -sag))])
    neck_pad = trace(Spline(*[ell(t, -arm / 2 - pad / 2 - g) for t in range(-112, -67, 11)]), pad)
    pads = [Pos(0, 0, 1) * extrude(s, H - 2) for s in (string_pad, neck_pad)]
    return Pos(0, 0, 40) * Rot(90, 0, 0) * Compound([upper3, lower3, *pads])   # stand it up: the neck runs along Y
