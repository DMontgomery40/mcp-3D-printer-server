"""Under-desk headphone hook (swept arm with a broad saddle, tape or two screws)
Pattern: sweep a rounded section along a filleted Polyline path; sweep a second, wider section along part of the same path
Modelled on: ElevationLab AnchorPro under-desk headphone mount (https://www.elevationlab.com/products/the-anchor-pro); screw is SPAX 4.0 mm flat countersunk (https://www.ahlsell.se/en/products/mounting/wood-screw/wood-screw-spax/71333788---traskruv-tft-spax-svart-4.0x25h-200fp-eta-120114)
Published sizes used: 4.0 mm = screw thread diameter, 8.0 mm = head diameter, 2.4 mm = head height (retailer listing for SPAX, URL above); the maker publishes no hook dimensions, so every hook size is a design choice
Concept: Hangs a headset under the desk, out of the way. Frame: the flat top face of the plate goes against the underside of the desk (tape, or two screws driven up from below), the arm drops, runs towards -y and turns up into a tip that stops the headband sliding off; the headband enters through the 42 mm gap between tip and plate. The headband lies across the saddle, a leaf 34 mm wide with fully rounded edges so the padding is not creased the way it is on a thin wire hook. The weight bends the arm at the two bends and pulls on the plate; the bends are large-radius and the stem is filleted into the plate. Print it on its side (X up) so every layer holds the whole J and the bends are not layer joints; the plate and saddle are wider than the arm, so on its side it needs supports under the arm and saddle. PETG or PLA, 4 walls.
What makes this good: one path drives both the slim arm and the broad saddle, so the saddle follows the bends like a moulded part.
"""
from build123d import *

P = {
    "plate_w": 72.0,       # plate across the desk edge (X); screws sit either side of the arm
    "plate_d": 36.0,       # plate front to back (Y); the tape area
    "plate_t": 5.0,        # plate thickness; leaves 2.6 mm under the screw head
    "screw_d": 4.0,        # screw thread diameter (published)
    "screw_head_d": 8.0,   # screw head diameter (published)
    "screw_head_h": 2.4,   # screw head height (published); sets the countersink depth
    "screw_clear": 0.5,    # added to thread and head diameters so the screw drops in
    "screw_pitch": 50.0,   # distance between the screws; clear of the saddle for the driver
    "arm_w": 16.0,         # arm section width (X)
    "arm_t": 11.0,         # arm section thickness, in the bending direction
    "drop": 62.0,          # plate underside down to the arm centreline
    "reach": 62.0,         # stem to tip, along the desk
    "tip_h": 20.0,         # tip rise above the arm centreline
    "bend_r": 14.0,        # radius of both bends
    "saddle_w": 34.0,      # saddle width: broad, so the headband padding is not dented
    "saddle_t": 8.0,       # saddle thickness; its edges are full rounds
    "saddle_lift": 3.5,    # saddle centre above the arm centreline, so its crown stands proud
    "saddle_from": 0.38,   # where the saddle starts along the path (0 = plate, 1 = tip)
    "saddle_to": 0.88,     # where it ends
    "root_fillet": 4.0,    # blend of the stem into the plate
}


def build():
    z_arm = P["arm_t"] / 2                 # arm centreline height; the arm's underside sits on z = 0
    z_plate = z_arm + P["drop"]            # plate underside
    # path as 3D points: inside the plate, down the stem, along the desk, up the tip
    path = Polyline((0, 0, z_plate + P["plate_t"] / 2), (0, 0, z_arm),
                    (0, -P["reach"], z_arm), (0, -P["reach"], z_arm + P["tip_h"]))
    path = fillet(path.vertices(), P["bend_r"])

    # the arm: an ellipse held square to the path at its start, swept to the tip
    arm = sweep(Plane(path @ 0, x_dir=(1, 0, 0), z_dir=path % 0) * Ellipse(P["arm_w"] / 2, P["arm_t"] / 2), path=path)
    tip = arm.faces().filter_by(GeomType.PLANE).sort_by(Axis.Z)[0]          # the lower flat end is the tip
    arm = fillet(tip.edges(), P["arm_t"] * 0.3)                              # rounded tip

    # the saddle: a wide round-edged slot swept along the middle of the same path, lifted to the
    # inside of the J (local +y of the section plane) so its top is what the headband touches
    run = path.trim(P["saddle_from"], P["saddle_to"])
    leaf = Plane(run @ 0, x_dir=(1, 0, 0), z_dir=run % 0) * Pos(0, P["saddle_lift"]) * SlotOverall(P["saddle_w"], P["saddle_t"])
    saddle = sweep(leaf, path=run)
    ends = saddle.faces().filter_by(GeomType.PLANE).edges()
    saddle = fillet(ends, P["saddle_t"] * 0.35)                              # soft ends

    # plate: flat on top for the desk, lower edge softened; stem blended in
    plate = Pos(0, 0, z_plate) * extrude(RectangleRounded(P["plate_w"], P["plate_d"], P["plate_d"] * 0.4), P["plate_t"])
    plate = fillet(plate.edges().group_by(Axis.Z)[0], P["plate_t"] * 0.4)
    body = plate + arm
    # the seam where the stem leaves the plate is the only spline edge on the plate's underside
    seam = body.edges().filter_by_position(Axis.Z, z_plate - 0.01, z_plate + 0.01).filter_by(GeomType.BSPLINE)
    body = fillet(seam, P["root_fillet"]) + saddle

    # two countersunk holes, heads on the underside, either side of the arm
    hole_r = (P["screw_d"] + P["screw_clear"]) / 2
    head_r = (P["screw_head_d"] + P["screw_clear"]) / 2
    screw = Cylinder(hole_r, 3 * P["plate_t"]) + Cone(head_r, hole_r, P["screw_head_h"], align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x in (P["screw_pitch"] / 2, -P["screw_pitch"] / 2):
        body -= Pos(x, 0, z_plate) * screw
    return body
