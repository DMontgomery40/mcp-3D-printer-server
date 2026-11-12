"""Ergonomic file handle with an oval palm swell
Use for: a handle or grip for a file, tool, drawer or lid; anything a hand closes round
Pattern: loft through several sections of different shape (circle to ovals), then fillet the end into a dome
Modelled on: Bahco ERGO 9-485 oval file handle (https://www.klium.nl/en/bahco-9-485-06-10-oval-shaped-handle-ergo-for-medium-flat-and-semi-circular-files-diameter-6-mm-76671)
Published sizes used: tang bore = 6 for medium files (retailer, Bahco 9-485-06, URL above); length = 110 (maker, Facom MAN.2 wood file handle, https://www.facom.com/product/man2/28mm-file-and-rasp-wood-handle); power-grip handle diameter 30 to 50, about 40 best, and handle length at least 100 (CCOHS, https://ccohs.ca/oshanswers/ergonomics/handtools/tooldesign.html); the swell here is 36 x 30. Waist, collar, butt and tang depth are design choices.
Concept: A push-on handle for a medium hand file (6 mm tang). The round collar at the front stands in for a steel ferrule and stops the fingers; behind it a round waist for thumb and forefinger swells into an oval that fills the palm (oval, so the hand feels which way the file faces and it cannot roll), then narrows to a domed butt the heel of the hand pushes on. The file's tapered tang is heated and pressed into the tapered hole. Prints as modelled, STANDING on the collar, no supports: every layer is then a closed ring round the tang, so the tang wedging the hole open cannot split it, and the swell and dome need nothing under them. The cost is that bending at the waist pulls layers apart, the weak direction; a file mostly pushes along the handle, so the waist is kept 20 mm thick with 5 walls. For a tool you lever with, print it lying down with supports instead. PETG. One body.
What makes this good: every section is sized for a part of the hand, and the loft joins them in one smooth skin.
"""
from build123d import *

P = {
    "length": 110.0,        # overall (Facom MAN.2)
    "collar_d": 25.0,       # front collar: finger stop and printed ferrule; also the foot it prints on
    "collar_len": 10.0,     # collar length
    "waist_d": 20.0,        # round waist for thumb and forefinger, just behind the collar
    "swell_z": 66.0,        # height of the palm swell above the collar end (where the palm closes)
    "swell_w": 36.0,        # palm swell width (CCOHS power grip 30 to 50)
    "swell_t": 30.0,        # palm swell thickness; less than the width so the hand can feel the file's angle
    "butt_w": 18.0,         # width of the end face before it is domed
    "butt_t": 15.0,         # thickness of the end face before it is domed
    "dome_r": 6.5,          # fillet that turns the end face into a dome for the heel of the hand
    "tang_d": 6.0,          # tang hole at the mouth (Bahco 9-485-06)
    "tang_tip_d": 3.0,      # tang hole at its far end: tangs taper
    "tang_depth": 60.0,     # tang hole depth
    "fit": 0.3,             # print allowance added to both tang hole diameters
}


def build():
    L, z0 = P["length"], P["collar_len"]
    zs = P["swell_z"]

    # Sections up the handle: round waist, a first oval, the full palm swell, a shoulder, the small end face.
    # Each one is a different shape; loft() skins them into one smooth body.
    sections = [
        Pos(0, 0, z0) * Circle(P["waist_d"] / 2),
        Pos(0, 0, (z0 + zs) / 2) * Ellipse(P["swell_w"] * 0.37, P["swell_t"] * 0.40),
        Pos(0, 0, zs) * Ellipse(P["swell_w"] / 2, P["swell_t"] / 2),
        Pos(0, 0, (zs + L) / 2) * Ellipse(P["swell_w"] * 0.46, P["swell_t"] * 0.46),
        Pos(0, 0, L) * Ellipse(P["butt_w"] / 2, P["butt_t"] / 2),
    ]
    grip = loft(sections)
    grip = fillet(grip.edges().group_by(Axis.Z)[-1], P["dome_r"])    # dome the butt

    # Front collar, rounded where the forefinger rests against it and chamfered where it meets the bed.
    collar = Cylinder(P["collar_d"] / 2, z0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    collar = fillet(collar.edges().group_by(Axis.Z)[-1], 2.0)
    collar = chamfer(collar.edges().group_by(Axis.Z)[0], 0.8)

    # Tapered tang hole, open at the collar end; its narrow top closes like a cone, so it prints unsupported.
    hole = Cone((P["tang_d"] + P["fit"]) / 2, (P["tang_tip_d"] + P["fit"]) / 2, P["tang_depth"],
                align=(Align.CENTER, Align.CENTER, Align.MIN))
    return grip + collar - hole
