"""Pocket clicker: a bistable double curved beam in a closed frame
Pattern: a computed 2D curve (cosine beam from a formula) made into a face, extruded flat with a filleted frame round it
Modelled on: the double curved-beam bistable mechanism of Qiu, Lang and Slocum, "A curved-beam bistable mechanism", J. Microelectromechanical Systems 13(2), 2004, pp. 137-146 (https://manuscript.isc.ac/Inventory/49/950908.htm)
Published sizes used: bistability ratio rise / thickness must exceed about 2.31 for a cosine beam clamped at both ends with its twisting mode blocked (Qiu, Lang and Slocum 2004, URL above); here rise / thickness = 3.0. All other sizes are design choices.
Concept: A one-piece fidget that snaps between two rest positions with a click. Two parallel beams, each pre-curved as one cosine wave, are clamped in the end walls of a closed frame and joined at the centre by a shuttle, so the centre cannot rotate and the beams must snap straight through instead of rolling over. Pushing the thumb pad squeezes the beams along their length; the two rails carry that thrust in tension, so the frame must be a closed ring that does not spread: if it spreads, the snap is lost. Travel stops on the rails catch the shuttle at 1.65 x rise, short of where the beams would come to rest on their own (a little under 2 x rise), so they keep pressing on the stop. MODELLED AS PRINTED, flat on the bed, because the beams must bend in the layer plane; each beam is 3 lines of 0.42 mm wide. Peak bending strain is about 2 pi^2 x thickness x rise / span^2 = 1.5 %, so print it in PETG, not brittle PLA. No supports. 1 body (print-in-place gap 0.4 mm at the stop).
What makes this good: the beam is computed from the published bistability ratio, and the frame is a rounded pebble, not a sharp slab.
"""
import math
from build123d import *

P = {
    "line_w": 0.42,        # one extrusion line
    "beam_lines": 3,       # beam thickness in whole lines (3 is the least for a spring)
    "rise_ratio": 3.0,     # rise / thickness; must be more than 2.31 to be bistable, more gives a harder click
    "span": 80.0,          # beam length between the end walls; longer is softer and strains the plastic less
    "beam_h": 5.0,         # beam height off the bed; taller is stiffer and resists the pad tipping
    "beam_pitch": 12.0,    # distance between the two beams; wide apart so the shuttle cannot twist
    "travel_ratio": 1.65,  # stop position as a multiple of the rise; keep it under about 1.8 so the beams still press on the stop
    "stop_gap": 0.4,       # print-in-place gap between the shuttle and the stop it is printed against
    "stop_len": 2.0,       # how far each travel stop stands out from its rail
    "shuttle_w": 14.0,     # shuttle and thumb pad width along the beams
    "shuttle_lip": 1.0,    # shuttle material beyond each beam so the beams are fully buried in it
    "pad_h": 11.5,         # top of the thumb pad above the bed (2.5 above the frame)
    "frame_h": 9.0,        # frame thickness
    "rail_w": 7.0,         # the two long rails that carry the beam thrust in tension
    "wall_w": 8.0,         # the two end walls the beams are clamped in
    "corner_r": 16.0,      # outside corner radius in plan, so it sits in a closed hand
    "edge_round": 3.5,     # fillet on the frame's top outside edge
    "lanyard_d": 4.0,      # keyring hole through one end wall
    "bed_chamfer": 1.0,    # chamfer on the bed side (a fillet touching the bed prints as a ragged overhang)
}


def cosine_beam(y0, span, rise, t):
    """Face of one beam: centreline y = rise/2 * (1 + cos(2 pi x / span)), thickness t measured along the normal."""
    def side(sign):
        pts = []
        for i in range(25):
            x = span * (i / 24 - 0.5)
            slope = -math.pi * rise / span * math.sin(2 * math.pi * x / span)
            n = math.hypot(1, slope)
            y = y0 + rise / 2 * (1 + math.cos(2 * math.pi * x / span))
            pts.append((x - sign * t / 2 * slope / n, y + sign * t / 2 / n))
        return Spline(*pts)
    upper, lower, bury = side(1), side(-1), Vector(1, 0)    # each end runs 1 mm into its wall so it fuses solidly
    right = Polyline(upper @ 1, (upper @ 1) + bury, (lower @ 1) + bury, lower @ 1)
    left = Polyline(lower @ 0, (lower @ 0) - bury, (upper @ 0) - bury, upper @ 0)
    return make_face([upper, right, lower, left])


def build():
    t = P["beam_lines"] * P["line_w"]
    rise = P["rise_ratio"] * t                    # the bistability condition, computed, not typed in
    travel = P["travel_ratio"] * rise
    span, pitch, lip = P["span"], P["beam_pitch"], P["shuttle_lip"]

    # Two beams (ends at y = 0 and y = pitch, bowed towards +Y as printed) and the shuttle that ties their centres.
    beams = cosine_beam(0, span, rise, t) + cosine_beam(pitch, span, rise, t)
    sh_lo, sh_hi = rise - t / 2 - lip, pitch + rise + t / 2 + lip
    shuttle = Pos(0, (sh_lo + sh_hi) / 2) * RectangleRounded(P["shuttle_w"], sh_hi - sh_lo, 5)

    # Window: room for the printed position, the stop gap, and the travel to the other stop.
    win_lo, win_hi = sh_lo - travel - P["stop_len"], sh_hi + P["stop_gap"] + P["stop_len"]
    win_mid, win_h = (win_lo + win_hi) / 2, win_hi - win_lo
    window = Pos(0, win_mid) * RectangleRounded(span, win_h, 4)
    stop = Rectangle(P["shuttle_w"], P["stop_len"] + 1)        # 1 mm buried in the rail
    stops = Pos(0, win_hi - P["stop_len"] / 2 + 0.5) * stop + Pos(0, win_lo + P["stop_len"] / 2 - 0.5) * stop

    # Closed frame: round the outside like a pebble BEFORE cutting the window, so only outside edges are touched.
    outline = RectangleRounded(span + 2 * P["wall_w"], win_h + 2 * P["rail_w"], P["corner_r"])
    slab = extrude(Pos(0, win_mid) * outline, P["frame_h"])
    slab = fillet(slab.edges().group_by(Axis.Z)[-1], P["edge_round"])
    slab = chamfer(slab.edges().group_by(Axis.Z)[0], P["bed_chamfer"])
    lanyard = Pos(-(span + P["wall_w"]) / 2, win_mid) * Circle(P["lanyard_d"] / 2)
    frame = slab - extrude(window + lanyard, P["frame_h"]) + extrude(stops, P["beam_h"])

    # Thumb pad: the shuttle carried up above the frame, with a domed top edge for the thumb.
    pad = extrude(shuttle, P["pad_h"])
    pad = fillet(pad.edges().group_by(Axis.Z)[-1], 3.0)
    ribs = [Pos(0, (sh_lo + sh_hi) / 2 + dy, P["pad_h"]) * Box(P["shuttle_w"], 1.2, 1.2) for dy in (-4, 0, 4)]
    return frame + extrude(beams, P["beam_h"]) + (pad - ribs)     # ribs across the push direction for thumb grip
