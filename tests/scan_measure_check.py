"""measure_scan on a synthetic capture: a sign standing on a slightly tilted turntable, fused to it as a scan fuses
them, with a floating chunk below (the DAD pass's scan, scan-to-make #859); and a plain object with no support.
With DAD_SCAN_MESH set (the DAD pass's scan/mesh.obj, metres, Y up), the real scan too."""
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import manifold3d as mf
import numpy as np
import trimesh

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src" / "cad"))
from scan_measure import measure_scan  # noqa: E402
from worker import scan_loader  # noqa: E402


def mesh(m):
    out = m.to_mesh()
    return trimesh.Trimesh(np.asarray(out.vert_properties)[:, :3], np.asarray(out.tri_verts), process=False)


def near(a, b, tol):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


with tempfile.TemporaryDirectory() as tmp:
    os.chdir(tmp)
    disc = mf.Manifold.cylinder(15, 110, 110, 96).translate((0, 0, -15))
    sign = mf.Manifold.cube((190, 20, 100)).translate((-95, -10, -1))
    chunk = mf.Manifold.cube((60, 50, 40)).translate((-30, -25, -90))
    tilt = trimesh.transformations.rotation_matrix(np.radians(1.0), [1, 0.3, 0])
    scan = mesh(mf.Manifold.batch_boolean([disc, sign], mf.OpType.Add))
    scan = trimesh.util.concatenate([scan, mesh(chunk)])
    scan.apply_transform(tilt)
    scan.apply_translation([0, 0, -scan.bounds[0, 2]])
    log = StringIO()
    with redirect_stdout(log):
        r = measure_scan(scan, picture="scan-measure.png")
    printed = json.loads(log.getvalue().strip().splitlines()[-1])["scan_measure"]
    assert printed["size_mm"] == r["size_mm"]
    assert near(r["size_mm"], [190, 20, 99.5], 1.0), r["size_mm"]
    assert r["support_removed"] and near([r["support_removed"]["tilt_deg"]], [1.0], 0.2), r["support_removed"]
    assert len(r["pieces_removed"]) == 1 and near(sorted(r["pieces_removed"][0]["size_mm"]), [40, 50, 60], 2), r["pieces_removed"]
    assert all(near([p["length_mm"], p["depth_mm"]], [190, 20], 1.5) for p in r["profile"]), r["profile"]
    assert Path("scan-measure.png").stat().st_size > 0
    # the object alone, cut 0.5 mm above the support it stood on, standing at z = 0
    assert near([r["mesh"].bounds[0, 2], r["mesh"].bounds[1, 2]], [0, r["size_mm"][2] - 0.5], 0.6), r["mesh"].bounds
    # with the size it would have if the cut piece were the object's own base, and a plain warning to check it
    assert near(r["support_removed"]["uncut_size_mm"], [220, 220, 114.5], 2), r["support_removed"]
    assert "own base" in r["support_removed"]["note"]
    assert near(r["scan_size_mm"][:2], [220, 220], 3), r["scan_size_mm"]

    # A product with its own base (scan-to-make #859 review): a lamp's square 100 x 100 x 10 foot under a 50 x 50 x 90
    # tower, no turntable. The foot is the product: nothing is cut.
    base = mf.Manifold.cube((100, 100, 10)).translate((-50, -50, 0))
    tower = mf.Manifold.cube((50, 50, 90)).translate((-25, -25, 10))
    with redirect_stdout(StringIO()):
        lamp = measure_scan(mesh(mf.Manifold.batch_boolean([base, tower], mf.OpType.Add)), picture=None)
    assert lamp["support_removed"] is None, lamp["support_removed"]
    assert near(lamp["size_mm"], [100, 100, 100], 0.01) and abs(lamp["volume_mm3"] - 325000) < 1, lamp

    # A footprint that is a line (a flat strip on edge) measures instead of raising.
    strip = trimesh.Trimesh([[0, 0, 0], [10, 0, 0], [10, 0, 5], [0, 0, 5]], [[0, 1, 2], [0, 2, 3]], process=False)
    with redirect_stdout(StringIO()):
        flat = measure_scan(strip, picture=None)
    assert near(flat["size_mm"], [10, 0, 5], 0.01), flat["size_mm"]

    # No support: a box measured as it is, nothing removed.
    with redirect_stdout(StringIO()):
        plain = measure_scan(mesh(mf.Manifold.cube((120, 30, 50))), picture=None)
    assert plain["support_removed"] is None and plain["pieces_removed"] == [], plain
    assert near(plain["size_mm"], [120, 30, 50], 0.01), plain["size_mm"]
    assert plain["volume_mm3"] and abs(plain["volume_mm3"] - 120 * 30 * 50) < 1, plain["volume_mm3"]
    # A box of twelve triangles still has a profile: the surface's cross-section at each height (Codex review, #169).
    assert len(plain["profile"]) == 10 and all(near([p["length_mm"], p["depth_mm"]], [120, 30], 0.01) for p in plain["profile"]), plain["profile"]

    # Debris and no turntable: the removed pieces count nowhere (Codex review, #169). A box with a speck 40 mm below
    # it and another 200 mm off to the side.
    scattered = trimesh.util.concatenate([mesh(mf.Manifold.cube((120, 30, 50))), mesh(mf.Manifold.cube((2, 2, 2)).translate((10, 10, -40))),
                                          mesh(mf.Manifold.cube((3, 3, 3)).translate((300, 0, 20)))])
    for support in (True, False):
        with redirect_stdout(StringIO()):
            clean = measure_scan(scattered, picture=None, support=support)
        assert near(clean["size_mm"], [120, 30, 50], 0.01), (support, clean["size_mm"])
        assert clean["pieces_removed_count"] == 2 and clean["support_removed"] is None, clean
        assert near([clean["mesh"].bounds[0, 2], clean["mesh"].bounds[1, 2]], [0, 50], 0.01), clean["mesh"].bounds
        assert all(near([p["length_mm"], p["depth_mm"]], [120, 30], 0.01) for p in clean["profile"]), clean["profile"]

    real = None
    if os.environ.get("DAD_SCAN_MESH"):
        load = scan_loader({"scan": os.environ["DAD_SCAN_MESH"]})
        with redirect_stdout(StringIO()):
            real = measure_scan(load("scan", source_units="m", up_axis="y"), picture=None)
        # The sign alone, about 190 x 20 x 100 mm, with the turntable disc and the floating chunk gone.
        assert near(real["size_mm"], [190, 20, 100], 6), real["size_mm"]
        assert real["support_removed"] and len(real["pieces_removed"]) == 1, real
        real = real["size_mm"]
print(json.dumps({"ok": True, "synthetic": r["size_mm"], "dad": real}))
