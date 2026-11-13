"""A purpose that holds nothing and mounts to nothing: a plant pot."""
from build123d import Box, Pos
P = {}
PURPOSE = {"for": "a small pot for a succulent", "modelled_on": "a terracotta cactus pot"}
def build():
    return Pos(0, 0, 5) * Box(10, 10, 10)
