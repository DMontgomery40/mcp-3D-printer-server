"""Clamp-on desk headphone hook (rounded S frame, printed thumbscrew, hook hanging under the desk)
Use for: hanging headphones, a bag or a cable coil from a desk, shelf or table edge without tape or screws; any clamp that grips a board 18 to 30 mm thick with a printed screw
Pattern: one rounded section swept along a filleted S path (top jaw, spine, lower jaw, drop, hook, tip); a boss for the nut thread; the screw and nut threads are one section on one helix, the nut's moved out by the fit; "pose" shows it clamped or on the plate
Modelled on: Brainwavz Hoist headphone hanger with adjustable clamp (https://brainwavzaudio.com/de/products/brainwavz-hoist-headphone-hanger-with-adjustable-clamp)
Published sizes used: 5 to 40 mm = desk thickness the bought clamp takes, 50 mm = its hanger width (maker's listing, URL above); this printed one is sized for 18 to 30 mm desks and every other size is a design choice
Concept: Hangs a headset under the desk edge with nothing stuck or screwed to the desk. 2 bodies: the frame and the thumbscrew. Frame as used: the desk edge is at x = 0 and the desk runs towards +x; the top jaw lies on the desk, the spine passes in front of the edge, the lower jaw runs back under the desk and carries the threaded boss, then the frame drops and comes forward again as the hook, with an upturned tip at the front so the headband lifts on and off from where you sit. The screw comes up through the boss and presses the underside of the desk, so one frame takes any desk from 18 to 30 mm; the headphones' weight pulls the frame down onto the top jaw, so the clamp only has to stop it sliding. The knob hangs in the hook's opening, above where the headband rests. The frame is printed on its side so every layer holds the whole S and no bend is a layer joint; its threaded hole then lies level, which a 4 mm pitch, 45 degree thread survives without supports. The screw prints standing on its knob. Stick felt on the top jaw and the screw tip. PETG or PLA, 4 walls.
What makes this good: the whole frame is a single swept bar with large bends, so it reads as a bent-steel hanger, not a bracket, and the load goes round the bends inside the layers.
"""
from build123d import *

P = {
    "pose": "plate",       # "plate": as printed, frame on its side and screw on its knob; "assembled": clamped on desk_t, standing as used (the screw is then off the plate, which cad_run notes: that pose is for looking, not printing)
    "desk_t": 25.0,        # the desk it is shown clamped on (assembled pose only)
    "opening": 32.0,       # between the jaws; takes desks up to 30 mm with a felt pad
    "min_desk": 18.0,      # thinnest desk the screw still reaches
    "reach": 46.0,         # jaws over the desk, from the desk edge
    "bar_t": 10.0,         # frame bar thickness, in the bending direction
    "width": 26.0,         # frame width = what the headband rests on
    "edge_r": 3.0,         # rounding of the bar's four long edges
    "bend_r": 13.0,        # centreline radius of every bend
    "drop": 84.0,          # lower jaw down to the hook arm (centrelines): knob plus a padded headband
    "hook_len": 60.0,      # hook arm, back towards the desk edge
    "tip_h": 24.0,         # upturned tip, centreline rise
    "boss_h": 18.0,        # threaded length through the lower jaw and its boss (4.5 turns)
    "boss_l": 28.0,        # boss length along the jaw
    "thread_d": 14.0,      # screw outside diameter
    "pitch": 4.0,          # coarse, so it prints lying level in the frame
    "thread_depth": 1.2,   # 45 degree flanks
    "crest": 0.8,          # flat on the thread crest
    "fit": 0.4,            # radial clearance, screw to nut
    "knob_d": 32.0,
    "knob_h": 11.0,
    "flutes": 8,
    "gap_on_plate": 10.0,  # frame to screw on the plate
    "print_in_place": False,  # two parts assembled by hand: only touching is a problem
}

# What it is for, as data: cad_run compiles it into requirements and evaluates them on use() below.
PURPOSE = {
    "for": "a hook that clamps under my 25 mm desk to hang my headphones",
    "modelled_on": "Brainwavz Hoist headphone hanger with adjustable clamp",
    "holds": [{"body": "headphones", "mass_g": 350}],
    "mounts": [{"body": "desk", "by": "clamp"}],
    "material": "PETG",
}


def thread(root_r, crest_r, z0, length):
    """A 45 degree trapezoid swept along a helix about Z, from z0. root_r > crest_r makes the nut's thread."""
    depth = crest_r - root_r
    half_root = P["crest"] / 2 + abs(depth)
    bury = 0.3 if depth > 0 else -0.3          # the flanks run on into the wall: no section corner lies on the wall's surface
    section = Polygon((root_r - bury, -half_root - 0.3), (crest_r, -P["crest"] / 2),
                      (crest_r, P["crest"] / 2), (root_r - bury, half_root + 0.3), align=None)
    return Pos(0, 0, z0) * sweep(Plane.XZ * section, path=Helix(P["pitch"], length, (root_r + crest_r) / 2), is_frenet=True)


def build():
    t, w, r = P["bar_t"], P["width"], P["bend_r"]
    major, root = P["thread_d"] / 2, P["thread_d"] / 2 - P["thread_depth"]
    low = -P["opening"] - t / 2                # lower jaw centreline; the desk top is y = 0
    x_spine = -(r - t / 2) - t / 2             # the inside of the bend ends at the desk edge
    x_screw = P["reach"] - P["boss_l"] / 2

    # frame, drawn lying on the bed: X into the desk, Y up as used, Z across the width
    path = Polyline((P["reach"], t / 2), (x_spine, t / 2), (x_spine, low), (P["reach"] + r, low),
                    (P["reach"] + r, low - P["drop"]), (P["reach"] + r - P["hook_len"], low - P["drop"]),
                    (P["reach"] + r - P["hook_len"], low - P["drop"] + P["tip_h"]))
    path = Pos(0, 0, w / 2) * fillet(path.vertices(), r)
    frame = sweep(Plane(path @ 0, x_dir=(0, 0, 1), z_dir=path % 0) * RectangleRounded(w, t, P["edge_r"]), path=path)
    ends = [frame.faces().sort_by_distance(path @ u)[0] for u in (0, 1)]
    frame = fillet(ends[0].edges() + ends[1].edges(), P["edge_r"] - 0.5)   # soft jaw end and hook tip; a radius over edge_r exports open
    boss = Pos(x_screw, -P["opening"] - P["boss_h"] / 2) * RectangleRounded(P["boss_l"], P["boss_h"], 5)
    frame += extrude(boss, w)

    # threads in the screw's own frame: axis Z, origin on the lower jaw's top face. Plain hole first, then the
    # nut's thread added to its wall (a thread subtracted from the cutter does not cut)
    z_nut = -P["boss_h"] + 2.5
    to_frame = Pos(x_screw, -P["opening"], w / 2) * Rot(-90, 0, 0)
    frame -= to_frame * Cylinder(major + P["fit"], 3 * P["boss_h"])
    frame += to_frame * thread(major + P["fit"], root + P["fit"], z_nut, P["boss_h"] - 5)

    # screw: fluted knob, threaded shank long enough for the thinnest desk, tip and thread ends cut to a chamfer
    shank = P["boss_h"] + P["opening"] - P["min_desk"] + 4
    kh = P["knob_h"]
    knob = fillet(Cylinder(P["knob_d"] / 2, kh, align=(Align.CENTER, Align.CENTER, Align.MIN)).edges(), 2.0)
    flute = Pos(P["knob_d"] / 2 + 1.5, 0, 0) * Cylinder(4.0, kh, align=(Align.CENTER, Align.CENTER, Align.MIN))
    knob -= [Rot(0, 0, i * 360 / P["flutes"]) * flute for i in range(P["flutes"])]
    # the envelope is wider than the thread (a surface shared with the crest breaks the cut) and chamfers the tip
    envelope = chamfer(Cylinder(major + 0.6, shank + 1, align=(Align.CENTER, Align.CENTER, Align.MIN)).edges().group_by(Axis.Z)[-1], P["thread_depth"] + 1.2)
    screw = knob + Pos(0, 0, kh - 1) * ((Cylinder(root, shank + 1, align=(Align.CENTER, Align.CENTER, Align.MIN))
                                         + thread(root, major, 2.0, shank - 3)) & envelope)

    if P["pose"] == "plate":
        return Compound([frame, Pos(P["reach"] + r + P["knob_d"] / 2 + P["gap_on_plate"], 0, 0) * screw])
    # assembled: tip on the underside of the desk; the turn that puts the screw's ridge in the nut's groove
    lift = P["opening"] - P["desk_t"] - (kh + shank)
    turn = 360 * (lift + kh + 1 - z_nut) / P["pitch"] + 180
    used = Rot(90, 0, 0) * Compound([frame, to_frame * Pos(0, 0, lift) * Rot(0, 0, turn) * screw])
    return Pos(0, 0, -used.bounding_box().min.Z) * used


def use():
    """As used: clamped on a desk_t desk whose top is the plane the top jaw lies on, a headband resting on the hook.
    A clamp's strength is not computed; its loads are, from where the headphones hang."""
    pose = P["pose"]
    P["pose"] = "assembled"
    try:
        shown = build()
    finally:
        P["pose"] = pose
    desk_top = shown.bounding_box().max.Z - P["bar_t"]       # the top jaw lies on the desk
    parts = shown.solids()
    for k, s in enumerate(parts):
        s.label = f"body {k + 1}"
    w = P["width"]
    desk = Pos(150, -w / 2, desk_top - P["desk_t"] / 2) * Box(300, 300, P["desk_t"])
    desk.label = "world:desk"
    hook_top = desk_top - P["opening"] - P["drop"]           # top of the hook arm
    x = P["reach"] + P["bend_r"] - P["hook_len"] / 2
    band = Pos(x, -w / 2, hook_top + 15) * Box(30, 60, 30)   # the headband where it rests
    band.label = "held:headphones"
    return Compound(children=[*parts, band, desk])
