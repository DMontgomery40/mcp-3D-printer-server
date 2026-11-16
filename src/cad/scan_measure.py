"""measure_scan(scan): a captured object measured once, before any design (scan-to-make #859).

A design pass measured the DAD sign's scan by hand twice, writing a script each time to drop the turntable and the
floating chunk under it. This does that in one call: it keeps the scan's main piece, cuts away a turntable or support
it stands on, and returns the object's size in its own frame (its long side along x), its width and depth at ten
heights, and front, side and top silhouettes with a millimetre scale, saved as one picture in the run folder.
"""
import json
from pathlib import Path

import numpy as np


def _components(V, F):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    A = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(V), len(V)))
    return connected_components(A, directed=False)[1]


def _support_plane(V, F, n, area, body):
    """The top of a turntable or support plate the object stands on, as a plane (point, unit normal), or None: the
    largest face-up plane in the lower part of the piece, reaching wider than what stands on it. Fitted, not assumed
    level: a turntable is often a degree or two off."""
    sel = body[F[:, 0]]
    up = sel & (n[:, 2] > 0.9)
    if not up.any():
        return None
    centres = V[F].mean(1)
    lo, hi = V[body][:, 2].min(), V[body][:, 2].max()
    weight, edges = np.histogram(centres[up, 2], bins=np.arange(lo, hi + 4.0, 4.0), weights=area[up])
    k = int(np.argmax(weight))
    near = up & (centres[:, 2] > edges[k] - 6) & (centres[:, 2] < edges[k + 1] + 6)
    for _ in range(3):
        normal = (n[near] * area[near, None]).sum(0)
        normal /= np.linalg.norm(normal)
        point = (centres[near] * area[near, None]).sum(0) / area[near].sum()
        near = sel & (n @ normal > np.cos(np.radians(5))) & (np.abs((centres - point) @ normal) < 2.0)
    plate_area = float(area[near].sum())
    height = (V - point) @ normal
    above = body & (height > 1.0)
    below = body & ~above
    footprint = np.ptp(V[body][:, 0]) * np.ptp(V[body][:, 1])
    if not above.any() or point[2] > lo + 0.6 * (hi - lo) or plate_area < 0.15 * footprint:
        return None
    # A turntable is round and reaches well past what stands on it. A product's own base (a lamp's square foot, a
    # plinth) usually isn't both; one that is still gets cut, and the result says so (uncut_size_mm, note).
    below_area, roundness = _hull_shape(V[below][:, :2])
    above_area, _ = _hull_shape(V[above][:, :2])
    if roundness < 0.8 or below_area < 2.5 * above_area:
        return None
    return point, normal


def _hull_shape(xy):
    """A footprint's convex-hull area and how round it is: the area over the circle through its farthest point (a
    disc is about 1, a square 0.64). (0, 0) when the footprint is a point or a line."""
    from scipy.spatial import ConvexHull, QhullError
    try:
        hull = ConvexHull(xy)
    except (QhullError, ValueError):
        return 0.0, 0.0
    ring = xy[hull.vertices]
    radius = np.linalg.norm(ring - ring.mean(0), axis=1).max()
    return float(hull.volume), float(hull.volume / (np.pi * radius ** 2)) if radius > 0 else 0.0


def _rect_yaw(xy):
    """The yaw (radians) that turns the footprint's smallest bounding rectangle square to x and y, its long side on x."""
    from scipy.spatial import ConvexHull, QhullError
    try:
        hull = xy[ConvexHull(xy).vertices]
    except (QhullError, ValueError):
        return 0.0  # a point or a line: measured in the scan's own x and y
    best = None
    for i in range(len(hull)):
        d = hull[(i + 1) % len(hull)] - hull[i]
        a = -np.arctan2(d[1], d[0])
        c, s = np.cos(a), np.sin(a)
        r = hull @ np.array([[c, s], [-s, c]])
        size = np.ptp(r, axis=0)
        if best is None or size[0] * size[1] < best[0]:
            best = (size[0] * size[1], a if size[0] >= size[1] else a + np.pi / 2)
    return best[1]


def _silhouettes(P, F, path, size):
    from PIL import Image, ImageDraw
    lo, hi = P.min(0), P.max(0)
    views = (("seen from -y (x, z)", 0, 2), ("seen from +x (y, z)", 1, 2), ("seen from above (x, y)", 0, 1))
    span = max(np.ptp(P[:, 0]), np.ptp(P[:, 1]), np.ptp(P[:, 2]))
    px, pad = 600, 40
    scale = (px - 2 * pad) / span
    sheet = Image.new("RGB", (px * 3, px), (255, 255, 255))
    for i, (name, a, b) in enumerate(views):
        im = Image.new("RGB", (px, px), (255, 255, 255))
        d = ImageDraw.Draw(im)
        T = P[F]
        for tri in T:
            d.polygon([(pad + (v[a] - lo[a]) * scale, px - pad - (v[b] - lo[b]) * scale) for v in tri], fill=(40, 40, 40))
        # a 10 mm grid and the extents written on it
        for g in np.arange(0, span + 10, 10):
            d.line([(pad + g * scale, px - pad + 6), (pad + g * scale, px - pad + 12)], fill=(200, 0, 0))
        d.text((8, 8), f"{name}: {np.ptp(P[:, a]):.1f} x {np.ptp(P[:, b]):.1f} mm; ticks every 10 mm", fill=(0, 0, 0))
        sheet.paste(im, (i * px, 0))
    sheet.save(path)


def measure_scan(scan, picture="scan-measure.png", support=True, levels=10):
    """The object in a captured scan, measured once. scan: load_scan's trimesh (mm, Z up). Prints one JSON line,
    {"scan_measure": {...}}, saves the silhouettes as `picture` in the run folder, and returns the same dict with
    "mesh": the object alone (a trimesh) in the scan's own x and y, standing at z = 0; when a support is removed it is
    levelled on the support's plane about the plane's own point and cut 0.5 mm above it."""
    import trimesh
    V = np.asarray(scan.vertices, dtype=np.float64)
    F = np.asarray(scan.faces, dtype=np.int64)
    scan_size = np.ptp(V, axis=0)
    tri = V[F]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    n = cross / np.maximum(np.linalg.norm(cross, axis=1), 1e-20)[:, None]
    label = _components(V, F)
    piece_area = np.bincount(label[F[:, 0]], area, label.max() + 1)
    main = int(np.argmax(piece_area))
    body = label == main
    removed = [{"size_mm": [round(float(v), 1) for v in np.ptp(V[label == k], axis=0)], "area_mm2": round(float(piece_area[k]), 1)}
               for k in np.argsort(-piece_area) if k != main and piece_area[k] > 0]
    plane = _support_plane(V, F, n, area, body) if support else None
    if plane is not None:
        # Stand the object on the support's plane, then keep what is above it.
        point, normal = plane
        axis = np.cross(normal, [0, 0, 1])
        angle = float(np.arccos(np.clip(normal[2], -1, 1)))
        V = V - point
        if np.linalg.norm(axis) > 1e-9:
            V = V @ trimesh.transformations.rotation_matrix(angle, axis / np.linalg.norm(axis))[:3, :3].T
        # Levelled about the support's own point, which keeps its x and y: the scan's x and y stay where they were.
        V = V + [point[0], point[1], 0.0]
    body_faces = body[F].all(1)
    obj = trimesh.Trimesh(V, F[body_faces], process=False)
    if plane is not None:
        # What stands on the support: cut 0.5 mm above its plane, then the largest connected piece above the cut.
        try:
            # Capped, so the object alone is closed again where it stood and its volume can be measured.
            obj = obj.slice_plane([0, 0, 0.5], [0, 0, 1], cap=True)
        except Exception:  # noqa: BLE001  (no triangulation engine for the cap: the open cut still measures)
            obj = obj.slice_plane([0, 0, 0.5], [0, 0, 1])
        obj.remove_unreferenced_vertices()
        label2 = _components(np.asarray(obj.vertices), np.asarray(obj.faces))
        pick = label2[obj.faces[:, 0]] == int(np.argmax(np.bincount(label2[obj.faces[:, 0]], obj.area_faces)))
        obj = trimesh.Trimesh(obj.vertices, obj.faces[pick], process=False)
        obj.remove_unreferenced_vertices()
    floor = 0.0 if plane is not None else float(obj.vertices[:, 2].min())
    obj.apply_translation([0, 0, -floor])
    used_V = np.asarray(obj.vertices)
    Fk = np.asarray(obj.faces)
    yaw = _rect_yaw(used_V[:, :2])
    c, s = np.cos(yaw), np.sin(yaw)
    R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    P = used_V @ R.T
    centre = (P.min(0) + P.max(0)) / 2
    P = P - [centre[0], centre[1], 0]
    size = np.ptp(P, axis=0)
    size[2] = P[:, 2].max()
    # The whole main piece in the same frame, support included: the size if the cut piece was the object's own base.
    whole = (V[body] - [0, 0, floor]) @ R.T
    uncut = np.ptp(whole, axis=0)
    profile = []
    for h in np.linspace(0, size[2], levels + 2)[1:-1]:
        band = np.abs(P[:, 2] - h) < max(size[2] / (levels * 4), 0.5)
        if band.sum() > 2:
            profile.append({"z_mm": round(float(h), 1), "length_mm": round(float(np.ptp(P[band, 0])), 1),
                            "depth_mm": round(float(np.ptp(P[band, 1])), 1)})
    report = {
        "size_mm": [round(float(v), 1) for v in size],
        "frame": "Object frame: x along its long side, y across, z up from where it stands; centred on x and y.",
        "yaw_deg": round(float(np.degrees(yaw)) % 180, 1),
        "scan_size_mm": [round(float(v), 1) for v in scan_size],
        "support_removed": None if plane is None else {
            "top_z_mm": round(float(plane[0][2]), 1), "tilt_deg": round(float(np.degrees(np.arccos(np.clip(plane[1][2], -1, 1)))), 1),
            "size_mm": [round(float(v), 1) for v in np.ptp(V[body & (V[:, 2] <= 0.5)], axis=0)],
            "uncut_size_mm": [round(float(v), 1) for v in uncut],
            "note": "A round plate wider than what stands on it was cut away as a turntable. If the photos show it is "
                    "the object's own base, design from uncut_size_mm instead."},
        "cut_mm": 0.5 if plane is not None else None,
        "pieces_removed": removed[:10],
        "profile": profile,
        "volume_mm3": None,
        "picture": str(picture) if picture else None,
    }
    if obj.is_watertight:
        report["volume_mm3"] = round(float(abs(obj.volume)), 1)
    # The object as returned stands at z = 0, its cut face on the plate.
    obj.apply_translation([0, 0, -float(obj.vertices[:, 2].min())])
    if picture:
        _silhouettes(P, Fk, Path(picture), size)
    print(json.dumps({"scan_measure": report}))
    return {**report, "mesh": obj}
