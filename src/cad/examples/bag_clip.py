"""Bag-sealing clip: two hinged bars, ridge into groove, snap latch, printed in place
Use for: closing a bag of food or sealing film; any clip with two hinged bars and a latch
Pattern: bar cross-section drawn in YZ and extruded along the bar; revolved waisted pin in a C-socket; ridge and its offset as the groove; modelled SHUT, then one bar swung open for printing
Modelled on: Linden Sweden Twixit! bag clip (https://www.webstaurantstore.com/linden-sweden-411-8-twixit-blue-4-1-4-pastry-bag-clips-pack/534411.8.html); mechanism as in the hinged-bar clip patent US 4656697, Naslund (https://patents.google.com/patent/US4656697)
Published sizes used: 108 mm (4 1/4 in) = overall length (retailer, https://www.webstaurantstore.com/linden-sweden-411-8-twixit-blue-4-1-4-pastry-bag-clips-pack/534411.8.html); nothing else is published, the other sizes are design choices
Concept: Closes an opened bag of coffee, crisps or frozen peas. Two bars are hinged at one end and latched at the other; a ridge along one bar pushes the bag film into a groove along the other, so the film is pinched on both flanks of the ridge for the whole length, which is what seals it (the bought clip does the same with two thin legs in a wedge channel). 2 bodies: bar A carries the ridge, the hinge pin on a neck, the yoke round the socket and the latch arm; bar B carries the groove and a C-shaped socket. The bag pushes the bars apart: at the hinge that load goes from the socket's closed side into the pin (the socket's opening faces backwards, away from the load), at the other end from B's back into the latch nose and down the arm. It is printed lying flat with the pin vertical and bar B swung 30 degrees open, because then the hinge is plain vertical walls with a 0.4 mm gap, the latch arm bends in the layer plane, and the 45 degree ridge, groove and pin waist need no support. The pin's V-waist stops B lifting off; the socket wraps 270 degrees of the pin so it cannot pull off sideways. The arm is 3 lines (1.26 mm) wide and 12.7 mm long: the 0.9 mm snap strains it about 1 percent. Push the round bead outward to open. PETG (PLA works, with a shorter life), 0.2 mm layers, no supports.
What makes this good: every working surface is either a vertical wall or a 45 degree flank, so the mechanism is exactly what the slicer prints, and the backs of the bars are bulged where the fingers squeeze.
"""
from build123d import *
from math import cos, radians, sin, sqrt

P = {
    "length": 108.0,      # overall, shut (published: 4 1/4 in)
    "height": 9.0,        # height off the bed = the clip's width across the bag
    "bar_w": 7.0,         # each bar, sealing face to the crown of its back
    "back_bulge": 1.2,    # how far the back bows out at mid-height (30 degrees at the bed, prints clean)
    "seal": 0.25,         # film gap between the bars, and between ridge and groove, when latched
    "ridge_h": 2.2,       # ridge height; its flanks are 45 degrees
    "ridge_tip": 0.6,     # flat on the ridge tip so it does not cut the film
    "gap": 0.4,           # print-in-place clearance in the hinge
    "pin_r": 3.5,         # hinge pin radius
    "waist": 1.5,         # depth of the pin's V-waist: stops bar B sliding off the pin
    "socket_wall": 2.0,   # wall of bar B's C-socket
    "yoke_t": 2.4,        # bar A's yoke round the socket
    "neck_w": 2.4,        # neck joining the pin to the yoke through the socket's opening
    "open_max": 40.0,     # degrees bar B can swing before the socket meets the neck
    "print_open": 30.0,   # degrees it is printed open
    "arm_t": 1.26,        # latch arm: 3 lines of 0.42, bends in the layer plane
    "arm_slot": 0.8,      # slot between the end of bar A and the arm
    "foot": 1.8,          # strip joining the arm to the back of bar A
    "catch": 0.9,         # overlap of the latch nose on bar B's back (more than the hinge play)
    "latch_clear": 0.25,  # clearance from bar B to the arm and to the nose, latched
    "grip_r": 2.2,        # round bead on the arm that the thumb pushes
}

def rect(x0, x1, y0, y1):
    return Pos((x0 + x1) / 2, (y0 + y1) / 2) * Rectangle(x1 - x0, y1 - y0)

def section(side):  # bar cross-section in YZ: flat sealing face at y = side * seal / 2, back bowed out for the fingers
    y0, h = P["seal"] / 2, P["height"]
    y1 = y0 + P["bar_w"] - P["back_bulge"]
    flat = Polyline((side * y1, 0), (side * y0, 0), (side * y0, h), (side * y1, h))
    back = ThreePointArc((side * y1, h), (side * (y0 + P["bar_w"]), h / 2), (side * y1, 0))
    return Plane.YZ * make_face(flat.edges() + back.edges())

def waisted(r, v):  # vertical pin of radius r with a 45 degree V-waist v deep at mid-height (no overhang past 45)
    h = P["height"]
    half = Polygon((0, 0), (r, 0), (r, h / 2 - v), (r - v, h / 2), (r, h / 2 + v), (r, h), (0, h), align=None)
    return revolve(Plane.XZ * half, Axis.Z)

def build():
    h, s, w, gap, clear = P["height"], P["seal"], P["bar_w"], P["gap"], P["latch_clear"]
    r_sock = P["pin_r"] + gap + P["socket_wall"]       # socket outside
    r_yoke = r_sock + gap                              # yoke inside
    r_head = r_yoke + P["yoke_t"]                      # the hinge axis is the Z axis; bars run along +X, A at -Y, B at +Y
    xi = P["length"] - r_head - 2 * P["grip_r"]        # inner face of the latch arm
    x_a, x_b = xi - P["arm_slot"], xi - clear          # ends of bar A and bar B
    y_a, y_c = -(s / 2 + w), s / 2 + w + clear         # back of bar A; catch face of the nose over bar B's back

    # bar A: bar, yoke under and behind the socket, neck and waisted pin
    yoke = Circle(r_head) - Circle(r_yoke) - Polygon((0, -s / 2), (50, -s / 2), (50, 50), (-50, 22), align=None)  # keep 155 to 360 degrees
    neck = rect(-r_yoke - 1, -1, -P["neck_w"] / 2, P["neck_w"] / 2)
    bar_a = extrude(section(-1), x_a) - Cylinder(r_yoke, 3 * h)
    # latch: foot, arm standing past bar B, nose with a lead-in ramp, round bead to push
    n = P["catch"] + clear
    y_top = y_c + 0.5 + 1.5 * n
    arm = rect(x_a - 2, xi + P["arm_t"], y_a, y_a + P["foot"]) + rect(xi, xi + P["arm_t"], y_a, y_top)
    nose = Polygon((xi + 0.1, y_c), (xi + 0.1, y_top), (xi - n, y_c + 0.5), (xi - n, y_c), align=None)   # anticlockwise, so it extrudes up
    bead = Pos(xi + P["grip_r"], y_top) * Circle(P["grip_r"])
    a = bar_a + extrude(yoke + neck + arm + nose + bead, h) + waisted(P["pin_r"], P["waist"])

    # ridge on A, and the same profile grown by the film gap as the groove in B
    zc, th, tip, x0 = h / 2, P["ridge_h"], P["ridge_tip"] / 2, r_head + 1
    ridge = Polygon((-s / 2 - 0.5, zc - th - tip), (-s / 2, zc - th - tip), (-s / 2 + th, zc - tip),
                    (-s / 2 + th, zc + tip), (-s / 2, zc + th + tip), (-s / 2 - 0.5, zc + th + tip), align=None)
    a += Pos(x0, 0, 0) * extrude(Plane.YZ * ridge, x_a - 2 - x0)
    groove = Pos(x0 - 1, 0, 0) * extrude(Plane.YZ * offset(ridge, s, kind=Kind.INTERSECTION), x_a - x0)

    # bar B: bar and C-socket. The opening is the neck's slot (neck + gap) swept through the swing, so it is no wider than it must be.
    far, slot_w = 3 * r_sock, P["neck_w"] / 2 + gap
    slot, turn = rect(-far, 0, -slot_w, slot_w), radians(180 - P["open_max"])
    swept = slot + Rot(0, 0, -P["open_max"]) * slot + Polygon((0, 0), (far * cos(turn), far * sin(turn)), (-far, 0), align=None)
    socket = Circle(r_sock) - swept
    b = extrude(section(1), x_b) + extrude(socket, h)
    b -= waisted(P["pin_r"] + gap, P["waist"] - gap * (sqrt(2) - 1)) + groove      # pin shape grown by gap, measured square to the surface

    return Compound([a, Rot(0, 0, P["print_open"]) * b])
