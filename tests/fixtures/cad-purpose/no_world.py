"""A holder whose purpose names a mount that use() never models."""
from build123d import Box, Compound, Pos
P = {}
PURPOSE = {"for": "a hook to hang my headphones", "modelled_on": "a stick-on headphone hook",
           "holds": [{"body": "headphones", "mass_g": 300}], "mounts": [{"body": "desk", "by": "tape"}]}
def build():
    return Pos(0, 0, 5) * Box(40, 20, 10)
def use():
    hook = Box(40, 20, 10); hook.label = "hook"
    cans = Pos(0, 0, 20) * Box(30, 30, 30); cans.label = "held:headphones"
    return Compound(children=[hook, cans])
