# A captive wheel in a frame after Gemini's fidget (council 2026-11-11, scan-to-make #734). v1=1 rebuilds the first
# version's two faults at once: windows cut the tie bar off the frame (+1 solid) and the pawl hanging from it lands on
# the wheel. declare=0 fuses everything into one shape, as that version did: the pawl and wheel merge (-1 solid) and
# the count still reads 2, with nothing to say which solid is meant to be which.
from build123d import Box, Compound, Cylinder, Pos
P = {"h": 6.0, "wheel_r": 10.0, "clear": 0.5, "v1": 0, "declare": 1}
def build():
    h, R, c = P["h"], P["wheel_r"], P["clear"]
    W, cham = R + 6, R + c + 1
    frame = Pos(0, 0, h / 2) * Box(2 * W, 2 * R + 20, h)
    frame = frame - Pos(0, -2, h / 2) * Box(2 * cham, 2 * R + 2 * c + 4, h)      # wheel chamber, y -14.5 .. 10.5
    frame = frame - Pos(0, 15.25, h / 2) * Box(2 * cham, 4.5, h)                 # upper window, y 13 .. 17.5: the tie bar is y 10.5 .. 13
    tip = R + 0.6 if not P["v1"] else R - 0.3                                   # v1: the tip sinks 0.3 mm into the wheel
    frame = frame + Pos(0, (12 + tip) / 2, h / 2) * Box(1.6, 12 - tip, h)        # pawl hanging from the tie bar
    if P["v1"]:
        for s in (-1, 1): frame = frame - Pos(s * 12.5, 11.75, h / 2) * Box(4.0, 3.5, h + 1)
    wheel = Pos(0, 0, h / 2) * Cylinder(R, h)
    if not P["declare"]:
        return frame + wheel
    frame.label, wheel.label = "frame", "wheel"
    return Compound(children=[frame, wheel])
