"""Screw-on wall coat hook (single curved arm with a ball tip)
Pattern: loft elliptical sections placed along a spline (an arm that tapers), ball tip, fillet the arm into the back plate
Modelled on: classic cast single coat hook; screw is SPAX 4.0 mm flat countersunk (https://www.ahlsell.se/en/products/mounting/wood-screw/wood-screw-spax/71333788---traskruv-tft-spax-svart-4.0x25h-200fp-eta-120114)
Published sizes used: 4.0 mm = screw thread diameter, 8.0 mm = head diameter, 2.4 mm = head height (retailer listing for SPAX, URL above); plate and arm sizes are design choices (no hook maker publishes them)
Concept: A coat hook for one heavy coat or bag. Frame: the wall is the XZ plane at y = 0, the hook reaches towards -y (towards the front view), Z is up. The coat's weight bends the arm like a cantilever, so the arm is deepest (in Z) where it meets the plate and thins towards the tip; the root is filleted so the stress does not peak at a sharp corner; the plate turns that bending into a pull on the top screw and a push on the wall at the bottom. The ball tip is fatter than the arm so a loop cannot slide off. Print it lying on its side (X up, one flank of the plate on the bed) so every layer contains the whole curve of the arm: printed plate-down, the arm would snap along a layer at the root. On its side the arm floats a few mm above the bed, so it needs supports under the arm and a brim. PETG or PLA, 4 walls.
What makes this good: the arm is a tapering loft along a curve with a filleted root and ball tip, like a cast hook, not a bent strip.
"""
from build123d import *

P = {
    "plate_w": 30.0,       # back plate width (X)
    "plate_h": 96.0,       # back plate height (Z)
    "plate_t": 6.0,        # back plate thickness (Y); leaves 3.6 mm under the screw head
    "plate_edge_r": 2.0,   # soft front edge of the plate
    "screw_d": 4.0,        # screw thread diameter (published)
    "screw_head_d": 8.0,   # screw head diameter (published)
    "screw_head_h": 2.4,   # screw head height (published); sets the countersink depth
    "screw_clear": 0.5,    # added to thread and head diameters so the screw drops in
    "screw_pitch": 68.0,   # distance between the two screws, one above and one below the arm
    "reach": 46.0,         # how far the tip stands off the plate face
    "dip": 9.0,            # how far the arm sags below its root before turning up (the coat sits here)
    "rise": 15.0,          # tip height above the root
    "root_w": 15.0,        # arm width (X) at the plate
    "root_h": 21.0,        # arm depth (Z) at the plate: deep where the bending is highest
    "tip_d": 10.0,         # arm diameter just under the ball
    "ball_d": 14.0,        # ball tip diameter
    "root_fillet": 4.0,    # blend of the arm into the plate
}


def build():
    t = P["plate_t"]
    # back plate: a slot outline (round ends) pulled off the wall, front edge softened
    plate = extrude(Plane.XZ * SlotOverall(P["plate_h"], P["plate_w"], rotation=90), t)
    plate = fillet(plate.edges().group_by(Axis.Y)[0], P["plate_edge_r"])

    # arm centreline in the YZ plane: leaves the plate square (so the root section stays
    # inside the plate), dips, then turns up to the tip
    spine = Spline(
        [(0, -1, 0), (0, -t - 0.5 * P["reach"], -P["dip"]), (0, -t - P["reach"], P["rise"])],
        tangents=[(0, -1, 0), (0, 0, 1)],
    )
    # ellipses square to the spine: deep and wide at the root, round at the tip
    sections = []
    for i in range(5):
        u = i / 4
        w = P["root_w"] + (P["tip_d"] - P["root_w"]) * u**0.6
        h = P["root_h"] + (P["tip_d"] - P["root_h"]) * u**0.6
        sections.append(Plane(spine @ u, x_dir=(1, 0, 0), z_dir=spine % u) * Ellipse(w / 2, h / 2))
    # ball tip; trimming 0.05 mm off the sphere's poles keeps the exported mesh watertight
    ball = Sphere(P["ball_d"] / 2) & Box(P["ball_d"], P["ball_d"], P["ball_d"] - 0.1)
    arm = loft(sections) + Pos(spine @ 1) * ball

    body = plate + arm
    # the seam where the arm meets the plate face is the only spline edge on that face
    seam = body.edges().filter_by_position(Axis.Y, -t - 0.01, -t + 0.01).filter_by(GeomType.BSPLINE)
    body = fillet(seam, P["root_fillet"])

    # two countersunk screw holes through the plate, heads flush with the front face
    hole_r = (P["screw_d"] + P["screw_clear"]) / 2
    head_r = (P["screw_head_d"] + P["screw_clear"]) / 2
    screw = Cylinder(hole_r, 3 * t) + Cone(hole_r, head_r, P["screw_head_h"], align=(Align.CENTER, Align.CENTER, Align.MAX))
    for z in (P["screw_pitch"] / 2, -P["screw_pitch"] / 2):
        body -= Pos(0, -t, z) * Rot(90, 0, 0) * screw
    return body
