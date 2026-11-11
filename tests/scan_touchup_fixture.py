"""A synthetic textured capture for scan_touchup tests: no personal scans.

A 20 mm sphere as a latitude/longitude grid with per-corner UVs, written as the capture converter writes a capture
(mesh.obj, mesh_basecolor_0.png, mesh_normal_0.png), in millimetres with Z up. Its colour has a white card patch, two
black dots and a dark arc; its normal map holds a known bump field on the far side; and the mesh has a loose piece,
a spike and a small hole.
"""
from pathlib import Path

import numpy as np
from PIL import Image

R = 20.0
NLON, NLAT = 64, 32
TEX = 512
BUMP_MM, BUMP_WAVE_MM = 0.25, 5.0
# Features in (longitude, latitude) degrees.
CARD = ((-40, 10), (-5, 40))
EYES = [(15, 25), (35, 25)]
ARC = [(10 + t, 8 + 6 * np.sin(np.radians(t * 6))) for t in np.linspace(0, 30, 61)]


def lonlat_to_uv(lon, lat):
    return (np.asarray(lon) + 180) / 360, (np.asarray(lat) + 90) / 180


def position(lon, lat):
    lon, lat = np.radians(lon), np.radians(lat)
    return np.stack([R * np.cos(lat) * np.cos(lon), R * np.cos(lat) * np.sin(lon), R * np.sin(lat)], axis=-1)


def bump(lon, lat):
    """The relief (mm) the normal map encodes: bumps on the far side (longitude 120..240), none elsewhere."""
    s = np.radians(lon) * R * np.cos(np.radians(lat))  # mm along the parallel
    t = np.radians(lat) * R  # mm along the meridian
    k = 2 * np.pi / BUMP_WAVE_MM
    window = (np.cos(np.radians(lon - 180)) > np.cos(np.radians(60))) & (np.abs(lat) < 40)
    return np.where(window, BUMP_MM * np.sin(k * s) * np.sin(k * t), 0.0)


def write(folder, hole=True, spike=True, floater=True):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    lons = np.linspace(-180, 180, NLON + 1)
    lats = np.linspace(-90, 90, NLAT + 1)
    LON, LAT = np.meshgrid(lons, lats)
    P = position(LON, LAT).reshape(-1, 3)
    U, V = lonlat_to_uv(LON, LAT)
    UV = np.stack([U.ravel(), V.ravel()], axis=1)
    idx = lambda i, j: i * (NLON + 1) + j  # noqa: E731
    faces = []
    for i in range(NLAT):
        for j in range(NLON):
            a, b, c, d = idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j)
            faces += [(a, b, c), (a, c, d)]
    faces = np.array(faces)
    if spike:
        k = idx(NLAT // 2 - 4, NLON // 2 + 20)  # one vertex pulled 6 mm out
        P[k] *= (R + 6) / R
    if hole:  # two triangles missing near the south pole
        faces = np.delete(faces, [2 * (3 * NLON + 5), 2 * (3 * NLON + 5) + 1], axis=0)
    lines = ["mtllib mesh.mtl"]
    lines += [f"v {float(x)!r} {float(y)!r} {float(z)!r}" for x, y, z in P]
    lines += [f"vt {float(u)!r} {float(v)!r}" for u, v in UV]
    lines.append("usemtl material_0")
    lines += [f"f {a + 1}/{a + 1} {b + 1}/{b + 1} {c + 1}/{c + 1}" for a, b, c in faces]
    if floater:  # a loose tetrahedron 10 mm off the sphere
        base = len(P) + 1
        tet = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=float) + [R + 10, 0, 0]
        lines += [f"v {float(x)!r} {float(y)!r} {float(z)!r}" for x, y, z in tet]
        t0 = len(UV) + 1
        lines.append("vt 0.5 0.5")
        lines += [f"f {base + a}/{t0} {base + b}/{t0} {base + c}/{t0}" for a, b, c in [(0, 2, 1), (0, 1, 3), (1, 2, 3), (0, 3, 2)]]
    (folder / "mesh.obj").write_text("\n".join(lines) + "\n")
    (folder / "mesh.mtl").write_text("newmtl material_0\nKd 1 1 1\nmap_Kd mesh_basecolor_0.png\n")

    # Texture space: lon/lat of each texel's centre (row 0 is the top, v = 1).
    x = (np.arange(TEX) + 0.5) / TEX
    lon_t = x * 360 - 180
    lat_t = (1 - x) * 180 - 90
    LT, AT = np.meshgrid(lon_t, lat_t)
    colour = np.empty((TEX, TEX, 3))
    colour[:] = [0.78, 0.62, 0.42]  # yarn tan
    (l0, a0), (l1, a1) = CARD
    colour[(LT >= l0) & (LT <= l1) & (AT >= a0) & (AT <= a1)] = [0.95, 0.94, 0.90]
    for lon, lat in EYES:
        d = np.hypot((LT - lon) * np.cos(np.radians(lat)), AT - lat)
        colour[d < 6.5] = [0.05, 0.05, 0.05]
    pts = np.array(ARC)
    for lon, lat in pts:
        d = np.hypot((LT - lon) * np.cos(np.radians(lat)), AT - lat)
        colour[d < 2.6] = [0.15, 0.13, 0.12]
    Image.fromarray((colour * 255).astype(np.uint8)).save(folder / "mesh_basecolor_0.png")

    # Tangent-space normals of the bump field: T along +U (east), B along +V (north).
    h = bump(LT, AT)
    ds = np.radians(360 / TEX) * R * np.maximum(np.cos(np.radians(AT)), 0.05)
    dt = np.radians(180 / TEX) * R
    hx = np.gradient(h, axis=1) / ds
    hy = -np.gradient(h, axis=0) / dt  # rows run south
    n = np.stack([-hx, -hy, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    Image.fromarray(np.round((n + 1) / 2 * 255).astype(np.uint8)).save(folder / "mesh_normal_0.png")
    return folder
