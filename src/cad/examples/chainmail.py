"""Chainmail patch: rigid square links that pass through each other, printed in place
Pattern: one link made from a rounded ring with two box cuts (two bars stay on the bed, two become bridges), then copied on a grid as a Compound of separate solids
Modelled on: NASA/JPL "space fabric" (https://www.jpl.nasa.gov/news/space-fabric-links-fashion-and-engineering) and Ed Nisley's printable chain mail (https://softsolder.com/2014/12/04/3d-printed-chain-mail-armor-cosplay-edition/)
Published sizes used: 2.4 mm = bar width, 6 threads of 0.40 mm (maker, https://softsolder.com/2014/12/04/3d-printed-chain-mail-armor-cosplay-edition/); JPL publishes no sizes; the other sizes are design choices
Concept: A flexible sheet of hard links for costume mail, a trivet, a strap or a fidget, printed flat in one go: rows x cols separate bodies (16 by default). Each link is a square ring whose two bars along X lie on the bed and whose two bars along Y are lifted one clearance higher, carried as short bridges by the four full-height corner posts. Turned 45 degrees and set on a square grid, every link's corner post stands inside the opening of each neighbour, so each pair of rings is threaded like two links of a chain; pull on the sheet and the load goes ring to ring through the posts. Flat feet (the low bars and posts) hold every link to the bed, the bridges span 7.2 mm over the two neighbour bars that pass under them, and nothing overhangs, so no supports. The raised bars are rounded for the hand; the bed edges are chamfered so first-layer squash cannot join neighbours. PETG or PLA, 0.2 mm layers.
What makes this good: the clearances are stated numbers that the pitch is derived from, so changing the link size keeps the links free, and solid_count proves they did not fuse.
"""
from build123d import *
from math import sqrt

P = {
    "rows": 4,            # links along Y
    "cols": 4,            # links along X
    "link": 12.0,         # outside of one square link (must be at least 4 * bar + 3 * gap)
    "bar": 2.4,           # bar width, and the outside corner radius: 6 lines of 0.4
    "bar_t": 1.2,         # bar thickness: 6 layers
    "lift": 0.8,          # vertical clearance between a low bar and the bridge over it: 4 layers
    "gap": 0.7,           # horizontal clearance between a neighbour's post and this link's bars
    "top_r": 0.8,         # rounding of the raised bars, the side the hand feels
    "foot_chamfer": 0.3,  # chamfer on the bed edges
}

# Why the links cannot come apart. Take a link at the origin, unrotated, and its neighbour one pitch away on the diagonal
# (pitch = link - 2 * bar - gap = 6.5). This link's corner post spans 3.6 to 6.0 in X and Y; the neighbour's near bars and
# post span 0.5 to 2.9, so the neighbour's post stands INSIDE this ring's opening (-3.6 to 3.6) and this post stands inside
# the neighbour's. Each ring is closed, so the two are threaded like chain links: this link's low bar (z 0 to 1.2) runs
# under the neighbour's bridge (z from 2.0) and its own bridge runs over the neighbour's low bar. To separate, a bar would
# have to pass through a bar. Gaps, from those coordinates: post to bar 3.6 - 2.9 = 0.7; post to the next neighbour's post
# 0.5 - (-0.5) = 1.0; link to the link two pitches away 13.0 - 12.0 = 1.0; low bar to bridge 2.0 - 1.2 = 0.8. All above 0.4.

def link():
    s, b, t = P["link"], P["bar"], P["bar_t"]
    high = t + P["lift"]                                # underside of the bridges
    ring = extrude(RectangleRounded(s, s, b) - Rectangle(s - 2 * b, s - 2 * b), high + t)
    low_align = (Align.CENTER, Align.CENTER, Align.MIN)
    ring -= Pos(0, 0, t) * Box(s - 2 * b, 2 * s, high, align=low_align)    # bars along X keep only their bottom: feet on the bed
    ring -= Box(2 * s, s - 2 * b, high, align=low_align)                   # bars along Y keep only their top: bridges between the posts
    ring = fillet(ring.edges().group_by(Axis.Z)[-1], P["top_r"])           # soft raised bars
    return chamfer(ring.edges().group_by(Axis.Z)[0], P["foot_chamfer"])    # room for first-layer squash

def build():
    pitch = P["link"] - 2 * P["bar"] - P["gap"]         # diagonal neighbour spacing that leaves `gap` beside each post
    step = pitch * sqrt(2)                              # the same lattice turned 45 degrees is a plain square grid
    one = Rot(0, 0, 45) * link()
    return Compound([Pos(c * step, r * step, 0) * one for r in range(P["rows"]) for c in range(P["cols"])])
