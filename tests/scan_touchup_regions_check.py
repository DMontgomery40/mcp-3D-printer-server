"""_regions on a coarse scan: a colour region of one or two vertices whose vertex area passes min_area
(scan-to-make #858, the DAD sign at the defaults of 6 clusters and 3 mm^2 raised IndexError)."""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "cad"))
from scan_touchup import _regions  # noqa: E402

n = 8
xs, ys = np.meshgrid(np.arange(n) * 10.0, np.arange(n) * 10.0)
V = np.stack([xs.ravel(), ys.ravel(), np.zeros(n * n)], 1)
F = np.array([t for i in range(n - 1) for j in range(n - 1)
              for t in ([i * n + j, i * n + j + 1, (i + 1) * n + j + 1], [i * n + j, (i + 1) * n + j + 1, (i + 1) * n + j])])
C = np.full((len(V), 3), 0.7)
C[3 * n + 3] = [0.05, 0.05, 0.05]            # one dark vertex: a one-vertex region of about 100 mm^2
C[5 * n + 2] = C[5 * n + 3] = [0.6, 0.1, 0.1]  # two red ones: a two-vertex region
label, regions = _regions(V, F, C, 3, 3.0)
assert len(regions) == 3, regions
assert regions[0]["colour"] == "#b3b3b3", regions[0]
small = sorted(regions[1:], key=lambda r: r["colour"])
assert small[0]["colour"] == "#0d0d0d" and small[0]["length_mm"] == 0 and small[0]["width_mm"] == 0, small
assert small[1]["colour"] == "#991a1a" and small[1]["length_mm"] == 10 and small[1]["width_mm"] == 0, small
print(json.dumps({"ok": True, "regions": len(regions)}))
