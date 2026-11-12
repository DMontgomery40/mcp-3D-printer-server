"""Adhesive desk cable clip (single cable, snap-in C channel on a taped pad)
Pattern: sweep a rounded (slot) section along an arc for the C ring + loft the pad up into it, fillet the lip tips
Modelled on: 3M Command Clear Round Cord Clips 17017CLR (https://argo.webstaurantstore.com/3m-command-8482-7100027385-clear-round-cord-clips-pack/39917017CLRES.html)
Published sizes used: 13/16 in (20.6 mm) = clip width, 1/2 in (12.7 mm) = clip depth (retailer, URL above); cable diameter, mouth and wall are design choices
Concept: A stick-on clip that parks one charging cable at the desk edge. The cable is pushed down through a mouth narrower than itself; the two lips of the C ring spring apart and close over it, so it slides lengthways but cannot lift out. The pull of the cable goes round the ring, down the lofted neck and spreads over the whole pad, which is flat for a foam tape square. Prints as modelled, pad on the bed, no supports (the channel is a 5.6 mm bridge-free arch). The lips are 4 lines wide and the ring is one continuous sweep, so the perimeters run round the C; the flex still crosses layers at the ring's sides, so print PETG (or PLA for light cables) and do not shrink the mouth below about 70% of the cable.
What makes this good: one swept ring with fully rounded lips and a neck that flows into the pad, so it reads as a moulded clip rather than a bracket.
"""
from math import asin, degrees

from build123d import *

P = {
    "cable_d": 5.0,      # cable it holds (design choice: a thick USB-C or power lead)
    "channel_clear": 0.6,  # channel is this much bigger than the cable so it slides
    "mouth": 3.6,        # gap between the lips; the cable squeezes through (72% of cable_d)
    "lip_t": 1.68,       # ring wall = 4 x 0.42 mm lines, thin enough to spring
    "ring_w": 8.0,       # ring length along the cable; wide so the jacket is not creased
    "tip_r": 0.7,        # rounding of the lip tips (finger and cable lead-in)
    "pad_l": 20.6,       # pad length across the cable (published clip width)
    "pad_w": 12.7,       # pad width along the cable (published clip depth)
    "pad_t": 1.2,        # pad edge thickness
    "pad_corner_r": 4.0,  # plan corner radius of the pad
    "seat_h": 3.4,       # underside of the cable above the taped face
    "cradle": 0.5,       # neck rises to this fraction of the channel radius below its centre
}


def build():
    r_in = (P["cable_d"] + P["channel_clear"]) / 2
    r_mid, r_out = r_in + P["lip_t"] / 2, r_in + P["lip_t"]
    zc = P["seat_h"] + r_in  # channel centre height

    # C ring: one sweep round the cable axis (Y), open at the top by the mouth angle
    half_mouth = degrees(asin(P["mouth"] / 2 / r_in))
    arc = Plane.XZ * CenterArc((0, zc), r_mid, 90 + half_mouth, 360 - 2 * half_mouth)
    section = Plane(arc @ 0, x_dir=(0, 1, 0), z_dir=arc % 0) * SlotOverall(P["ring_w"], P["lip_t"])
    ring = sweep(section, path=arc)
    # round the two lip tips: the only flat faces on the ring are its ends
    tips = ring.faces().filter_by(GeomType.PLANE).edges()
    ring = fillet(tips, P["tip_r"])

    # pad + neck: loft from the tape footprint up round the lower third of the ring, so the
    # cable's pull spreads into the whole pad and only the upper lips are free to spring
    neck_top = zc - r_in * P["cradle"]
    neck_l = 2 * (r_out**2 - (zc - neck_top) ** 2) ** 0.5  # chord of the ring at that height
    base = loft([
        Plane.XY * RectangleRounded(P["pad_l"], P["pad_w"], P["pad_corner_r"]),
        Plane.XY.offset(P["pad_t"]) * RectangleRounded(P["pad_l"] - 1, P["pad_w"] - 1, P["pad_corner_r"] - 0.5),
        Plane.XY.offset(P["pad_t"] + 0.8) * RectangleRounded(neck_l + 3, P["ring_w"], 2.5),
        Plane.XY.offset(neck_top) * RectangleRounded(neck_l, P["ring_w"] - 1.5, 2.0),
    ])
    # clear the channel out of the neck; cutting at mid-wall hides the cut inside the ring,
    # so the cable only ever touches the smooth swept surface
    base -= Pos(0, 0, zc) * Rot(90, 0, 0) * Cylinder(r_mid, P["pad_w"])
    return base + ring
