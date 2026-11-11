# Many near pairs, for the exact-measurement cap and problem summaries (Muse's review, 2026-11-11): a row of n boxes
# gap mm apart.
from build123d import Box, Compound, Pos
P = {"n": 25, "gap": 0.31}
def build():
    out = []
    for k in range(P["n"]):
        b = Pos(k * (5 + P["gap"]), 0, 2.5) * Box(5, 5, 5); b.label = f"box {k + 1}"; out.append(b)
    return Compound(children=out)
