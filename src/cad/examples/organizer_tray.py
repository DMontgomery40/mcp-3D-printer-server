"""Drawer organiser tray (tapered bin with rounded corners, scooped floor and one divider)
Use for: a tray, bin, tub or caddy for small things in a drawer, on a desk or a shelf (pens, cutlery, make-up, screws, chargers); any open box sized to a measured space
Pattern: loft a rounded rectangle up to a larger one for the tapered outside, cut a second loft for the inside, fillet the inside floor edge before the cut; a divider trimmed to the inside by intersecting it with the outside
Modelled on: madesmart Classic 9.75 x 3.75 in drawer organiser tray (https://www.canadiantire.ca/en/pdp/p-1423398p.html)
Published sizes used: 9.75 x 3.75 x 2.13 in (248 x 95 x 54 mm) = the bought tray's outside length, width and height (retailer listing, URL above); the taper, corner radius, wall and divider are design choices
Concept: An open tray that sits in a drawer and keeps one kind of thing together. What makes the bought one pleasant is all in the shape: the walls lean out about 3 degrees so trays nest and fingers get in, the corners are round in plan so nothing lodges in them, and the floor curves up into the walls so a coin or a screw slides up and out under one finger instead of hiding in a square corner. One divider makes a short compartment for small things; it is the same thickness as the walls and joins them along its whole height. Printed upright as modelled, floor on the bed, no supports: the walls lean outwards by far less than 45 degrees. The walls are 4 lines (1.6 mm), stiff enough at this height because the rounded corners and the divider brace them. PLA or PETG, 0.2 mm layers. Size it from the drawer's inside width and the things' length, 1 mm under the space it goes into.
What makes this good: the taper, the round plan corners and the scooped floor are the whole difference between a tray and a box, and each is one operation here.
"""
from build123d import *

P = {
    "length": 248.0,        # outside, at the rim (published)
    "width": 95.0,          # outside, at the rim (published)
    "height": 54.0,         # outside (published)
    "taper": 3.0,           # each side is this much smaller at the floor (about 3 degrees)
    "corner_r": 14.0,       # plan corner radius at the rim
    "wall": 1.6,            # 4 lines of 0.4
    "floor": 1.2,
    "scoop_r": 8.0,         # radius where the floor curves up into the walls
    "divider_at": 0.3,      # divider position along the length (0 to 1); 0 for none
}


def shell_loft(inset, z0):
    """The tray's tapered shape, `inset` smaller all round, from height z0 to the rim."""
    l, w, r, h = P["length"] - 2 * inset, P["width"] - 2 * inset, P["corner_r"] - inset, P["height"]
    shrink = 2 * P["taper"] * (1 - z0 / h)                      # the taper at height z0
    return loft([Plane.XY.offset(z0) * RectangleRounded(l - shrink, w - shrink, r - P["taper"] * 0.5),
                 Plane.XY.offset(h) * RectangleRounded(l, w, r)])


def build():
    outside = shell_loft(0, 0)
    inside = shell_loft(P["wall"], P["floor"])
    inside = fillet(inside.edges().group_by(Axis.Z)[0], P["scoop_r"])     # the scoop, made on the plain inside shape
    tray = outside - inside
    if P["divider_at"] > 0:
        x = (P["divider_at"] - 0.5) * P["length"]
        wall = Pos(x, 0, P["height"] / 2) * Box(P["wall"], P["width"], P["height"])
        tray += wall & outside                                             # trimmed to the tapered outside, so it meets both walls
    return tray
