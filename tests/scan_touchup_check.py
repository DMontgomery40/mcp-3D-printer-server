"""scan_touchup on a synthetic capture, loaded the way load_scan loads one. Run by cad-scan-touchup.test.mjs."""
import json
import sys
import tempfile
import time
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import numpy as np
import trimesh

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src" / "cad"))
sys.path.insert(0, str(HERE))
import scan_touchup_fixture as fx  # noqa: E402
from scan_touchup import scan_touchup_factory  # noqa: E402
from worker import scan_loader  # noqa: E402


def near(regions, lon, lat):
    p = fx.position(lon, lat)
    return min(regions[1:], key=lambda r: np.linalg.norm(np.array(r["centre_mm"]) - p))


with tempfile.TemporaryDirectory() as tmp:
    folder = fx.write(Path(tmp) / "scan")
    inputs = {"scan": str(folder / "mesh.obj"), "colour": str(folder / "mesh_basecolor_0.png"),
              "normal": str(folder / "mesh_normal_0.png")}
    load_scan, scan_touchup = scan_loader(inputs), scan_touchup_factory(inputs)
    started = time.time()
    log = StringIO()
    with redirect_stdout(log):
        t = scan_touchup(load_scan("scan", source_units="mm", up_axis="z", ground=False), colour="colour", normal="normal")
        regions = t.regions(picture=str(Path(tmp) / "regions.png"))
    assert (Path(tmp) / "regions.png").stat().st_size > 0
    assert '"scan_regions"' in log.getvalue()
    stats = t.stats
    assert stats["loose_pieces_removed"] == 1, stats
    assert stats["spike_points_moved"] >= 1, stats
    assert stats["holes_closed"] == 1, stats
    assert stats["mean_edge_mm"] <= 0.5 and stats["triangles"] <= 240_000, stats

    card = near(regions, -22.5, 25)
    assert card["area_mm2"] > 50 and card["colour"].startswith("#f"), card
    eyes = [near(regions, lon, lat) for lon, lat in fx.EYES]
    for eye, (lon, lat) in zip(eyes, fx.EYES):
        assert np.linalg.norm(np.array(eye["centre_mm"]) - fx.position(lon, lat)) < 1.0, eye
    arc = near(regions, 25, 8)
    assert arc["length_mm"] > 8 and arc["width_mm"] < arc["length_mm"] / 2, arc

    # Relief alone: the normal map's bumps come back at their height and place; nothing elsewhere moves.
    with redirect_stdout(StringIO()):
        plain = scan_touchup(load_scan("scan", source_units="mm", up_axis="z", ground=False), colour="colour", normal="normal").mesh()
    assert plain.is_watertight and plain.is_winding_consistent and len(plain.split(only_watertight=False)) == 1
    V = np.asarray(plain.vertices)
    r = np.linalg.norm(V, axis=1)
    assert r.max() < fx.R + 1.0, "the spike is gone"
    assert abs(np.median(r) - fx.R) < 0.05, "refined without shrinking"
    lon = np.degrees(np.arctan2(V[:, 1], V[:, 0]))
    lat = np.degrees(np.arcsin(np.clip(V[:, 2] / r, -1, 1)))
    window = (np.cos(np.radians(lon - 180)) > np.cos(np.radians(45))) & (np.abs(lat) < 30)
    truth = fx.bump(lon, lat)[window]
    assert np.corrcoef(r[window] - fx.R, truth)[0, 1] > 0.8
    ratio = (r[window] - fx.R).std() / truth.std()
    assert 0.6 < ratio < 1.3, ratio
    assert np.abs(r[np.cos(np.radians(lon - 180)) < 0] - fx.R).max() < 0.12, "no relief invented from colour"

    # The plan: a flat card, two beads, a cord along the arc, a seat.
    with redirect_stdout(StringIO()):
        t.flatten([card["id"]], shape="plane", max_move_mm=3, name="Card")
        t.bead(eyes[0]["id"], 3.0, 1.2, name="Eye").bead(eyes[1]["id"], name="Eye")
        t.cord(arc["id"], 1.2, 0.6, name="Arc")
        t.seat(2.0)
        out = t.mesh(relief_gain=0)
    assert out.is_watertight and len(out.split(only_watertight=False)) == 1
    W = np.asarray(out.vertices).copy()
    assert abs(W[:, 2].min()) < 1e-4
    W[:, 2] -= fx.R - 2.0  # back to the scan's frame
    centre = fx.position(-22.5, 25)
    pts = W[(np.linalg.norm(W - centre, axis=1) < 4) & (np.linalg.norm(W, axis=1) < fx.R + 0.3)]
    assert np.linalg.svd(pts - pts.mean(0), full_matrices=False)[1][2] / np.sqrt(len(pts)) < 0.05, "card flat"
    for (lon, lat), low in zip(fx.EYES, (1.05, 0.8)):
        p = fx.position(lon, lat)
        assert np.linalg.norm(W[np.linalg.norm(W - p, axis=1) < 3], axis=1).max() - fx.R > low
    heights = [np.linalg.norm(W[np.linalg.norm(W - fx.position(lo, la), axis=1) < 0.9], axis=1).max() - fx.R
               for lo, la in fx.ARC[5:-5]]
    assert min(heights) > 0.35 and max(heights) - min(heights) < 0.4, heights  # one cord, not beads with gaps
    # Texture relief (opt-in): the colour's stitch pattern becomes relief on the textile, not on the flattened card.
    with redirect_stdout(StringIO()):
        t2 = scan_touchup(load_scan("scan", source_units="mm", up_axis="z", ground=False), colour="colour", normal="normal")
        t2.flatten([card["id"]], shape="plane", max_move_mm=3, name="Card").texture_relief(0.8, name="Yarn")
        knit = t2.mesh(relief_gain=0)
    K = np.asarray(knit.vertices)
    rk = np.linalg.norm(K, axis=1)
    lon_k = np.degrees(np.arctan2(K[:, 1], K[:, 0]))
    lat_k = np.degrees(np.arcsin(np.clip(K[:, 2] / rk, -1, 1)))
    inside = (lon_k > 65) & (lon_k < 105) & (np.abs(lat_k) < 25)
    assert np.corrcoef(rk[inside] - fx.R, fx.stitches(lon_k, lat_k)[inside])[0, 1] > 0.7, "lit loops raised"
    assert 0.5 < np.ptp(rk[inside]) < 1.0, np.ptp(rk[inside])
    on_card = K[np.linalg.norm(K - fx.position(-22.5, 25), axis=1) < 4]
    assert np.linalg.svd(on_card - on_card.mean(0), full_matrices=False)[1][2] / np.sqrt(len(on_card)) < 0.05, "card stays flat"
    assert ("assumed", "Yarn: stitch pattern raised from the colour texture, 0.8 mm peak to peak, on the textile only") in t2.changes
    try:
        t2.texture_relief(5)
    except ValueError:
        pass
    else:
        raise AssertionError("an unbounded texture height was accepted")
    tags = {text.split(":")[0]: tag for tag, text in t.changes}
    assert tags.get("Eye") == "assumed" and tags.get("Arc") == "assumed", tags
    try:
        t.bead(999)
    except ValueError as error:
        assert "no region 999" in str(error)
    else:
        raise AssertionError("an unknown region was accepted")
    # Two constant-colour UV islands packed 4 texels apart, inside the coarse blur: the stitch band must stay 0 on
    # both, or the atlas layout would raise ridges at their borders (Codex review, 2026-11-11).
    from scan_touchup import _texture_band
    w = h = 200
    UVq = np.array([[0.10, 0.1], [0.45, 0.1], [0.45, 0.9], [0.10, 0.9], [0.47, 0.1], [0.82, 0.1], [0.82, 0.9], [0.47, 0.9]])
    Vq = np.array([[0, 0, 0], [7, 0, 0], [7, 16, 0], [0, 16, 0], [20, 0, 0], [27, 0, 0], [27, 16, 0], [20, 16, 0]], float)
    Fq = np.array([[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]])
    rgb = np.full((h, w, 3), 0.2, dtype=np.float32)
    rgb[:, int(0.46 * w):] = 0.8
    band = _texture_band(rgb, UVq, Fq, Vq, Fq, 0.4, 3.0)
    assert np.abs(band).max() < 1e-4, f"atlas neighbours bled into the stitch band: {np.abs(band).max()}"
    print(json.dumps({"ok": True, "seconds": round(time.time() - started, 1)}))
