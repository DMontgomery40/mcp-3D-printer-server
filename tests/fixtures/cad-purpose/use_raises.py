"""A use() with a bug: the export stands, the run is not ready."""
from build123d import Box, Pos
P = {}
PURPOSE = {"for": "a hook to hang my keys", "modelled_on": "a wall key hook",
           "holds": [{"body": "keys", "mass_g": 80}], "mounts": [{"body": "wall", "by": "screw"}]}
def build():
    return Pos(0, 0, 5) * Box(40, 20, 10)
def use():
    return undefined_name
