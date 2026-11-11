"""Scan touch-up helpers for mesh-mode build(): a captured scan's own maps, never Blender.

scan_touchup(load_scan(...), colour="colour", normal="normal") takes load_scan's textured mesh (its UVs kept) and
the declared colour and normal map inputs, and returns a ScanTouchup. Its steps are recorded and run in a fixed
order by .mesh(): clean (loose pieces, spikes, holes) -> refine (smaller triangles, the body's size kept) -> relief
(the normal map's measured detail) -> texture relief (opt-in: a textile's stitch pattern from the colour texture)
-> flatten -> beads and cords (manifold3d union) -> seat.
.regions() lists the colour regions by id (printed to build.log, with regions.png in the run folder) so the other
steps can name them. Relief is the measured detail by default; colour says where a feature is, and makes relief
only through texture_relief(), for a textile the photos show in relief.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components, dijkstra

MAX_TRIANGLES = 240_000  # the engine's inspect step reads at most 250,000


# --- mesh basics (positions welded; UVs kept per face corner) -----------------------------------------------------

def _face_normals(V, F, unit=True):
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-20) if unit else n


def _vertex_normals(V, F):
    fn = _face_normals(V, F, unit=False)
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    return vn / (np.linalg.norm(vn, axis=1, keepdims=True) + 1e-20)


def _edges(F):
    return np.unique(np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1), axis=0)


def _adjacency(V, F):
    e = _edges(F)
    n = len(V)
    return sparse.coo_matrix((np.ones(2 * len(e)), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])),
                             shape=(n, n)).tocsr()


def _vertex_areas(V, F):
    fa = np.linalg.norm(_face_normals(V, F, unit=False), axis=1) / 6
    va = np.zeros(len(V))
    for k in range(3):
        np.add.at(va, F[:, k], fa)
    return va


def _components(mask, A):
    idx = np.flatnonzero(mask)
    label = np.full(len(mask), -1, dtype=np.int64)
    if not len(idx):
        return label, 0
    n, lab = connected_components(A[idx][:, idx], directed=False)
    label[idx] = lab
    return label, n


def _distance(A, V, seeds, limit):
    """Distance over the mesh's edges from a vertex set, up to limit mm (inf beyond)."""
    coo = A.tocoo()
    n = len(V)
    seeds = np.flatnonzero(seeds)
    if not len(seeds):
        return np.full(n, np.inf)
    w = np.linalg.norm(V[coo.row] - V[coo.col], axis=1)
    G = sparse.csr_matrix((np.r_[w, np.full(len(seeds), 1e-12)], (np.r_[coo.row, np.full(len(seeds), n)],
                                                                np.r_[coo.col, seeds])), shape=(n + 1, n + 1))
    return dijkstra(G, directed=True, indices=n, limit=limit)[:n]


def _sample(image, uv):
    h, w = image.shape[:2]
    x = np.clip(uv[:, 0], 0, 1) * (w - 1)
    y = np.clip(1 - uv[:, 1], 0, 1) * (h - 1)
    x0, y0 = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = x - x0, y - y0
    if image.ndim == 3:
        fx, fy = fx[:, None], fy[:, None]
    return (image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x1] * fx * (1 - fy)
            + image[y1, x0] * (1 - fx) * fy + image[y1, x1] * fx * fy)


def _per_vertex(values, F, FT, n):
    total = np.zeros((n,) + values.shape[1:])
    count = np.zeros(n)
    for k in range(3):
        np.add.at(total, F[:, k], values[FT[:, k]])
        np.add.at(count, F[:, k], 1)
    count = np.maximum(count, 1)
    return total / (count[:, None] if total.ndim == 2 else count)


# --- clean and refine --------------------------------------------------------------------------------------------

def _drop_floaters(V, F, FT, keep_fraction=0.02):
    n, label = connected_components(_adjacency(V, F), directed=False)
    if n <= 1:
        return V, F, FT, 0
    fl = label[F[:, 0]]
    area = np.bincount(fl, np.linalg.norm(_face_normals(V, F, unit=False), axis=1), n)
    keep = area >= keep_fraction * area.max()
    used = np.unique(F[keep[fl]])
    remap = np.full(len(V), -1)
    remap[used] = np.arange(len(used))
    return V[used], remap[F[keep[fl]]], None if FT is None else FT[keep[fl]], int((~keep & (area > 0)).sum())


def _remove_spikes(V, F, rounds=4):
    """A vertex standing out of its neighbours' centre by more than 1.5 times their own spread around it (a cone
    sharper than about 34 degrees) is a needle or a fused fin tip: it goes to that centre, repeatedly, so a spike
    recedes from its tip. Bumps and the object's own features rise over several edge lengths and stay."""
    A = _adjacency(V, F)
    deg = np.maximum(np.asarray(A.sum(axis=1)).ravel(), 1)
    moved = np.zeros(len(V), dtype=bool)
    V = V.copy()
    for _ in range(rounds):
        mean = (A @ V) / deg[:, None]
        spread = np.sqrt(np.maximum((A @ (V ** 2).sum(1)) / deg - (mean ** 2).sum(1), 0))
        height = np.abs(np.einsum("ij,ij->i", V - mean, _vertex_normals(V, F)))
        spike = height > 1.5 * spread
        if not spike.any():
            break
        V[spike] = mean[spike]
        moved |= spike
    return V, int(moved.sum())


def _fill_holes(V, F, FT, max_rim=2000):
    directed = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    _, inv, cnt = np.unique(np.sort(directed, axis=1), axis=0, return_inverse=True, return_counts=True)
    rim = directed[cnt[inv.reshape(-1)] == 1]
    if not len(rim):
        return V, F, FT, 0
    nxt = {int(a): int(b) for a, b in rim}
    seen, loops = set(), []
    for start in list(nxt):
        loop, v = [], start
        while v not in seen and v in nxt:
            seen.add(v)
            loop.append(v)
            v = nxt[v]
        if v == start and 3 <= len(loop) <= max_rim:
            loops.append(loop)
    corner = {}
    if FT is not None:
        for k in range(3):
            for vi, ti in zip(F[:, k], FT[:, k]):
                corner.setdefault(int(vi), int(ti))
    Vs, Fs, FTs = [V], [F], [FT]
    n = len(V)
    for loop in loops:
        Vs.append(V[loop].mean(axis=0)[None])
        tris = np.array([[loop[(i + 1) % len(loop)], loop[i], n] for i in range(len(loop))])
        Fs.append(tris)
        if FT is not None:
            FTs.append(np.array([[corner[int(a)], corner[int(b)], corner[int(a)]] for a, b, _ in tris]))
        n += 1
    return np.concatenate(Vs), np.concatenate(Fs), None if FT is None else np.concatenate(FTs), len(loops)


def _subdivide(V, F, UV, FT):
    """1-to-4 split. New edge points sit on the curved surface the vertex normals describe (Phong tessellation), so
    original vertices never move and the body is not shrunk; UVs split per corner, so seams stay seams."""
    N = _vertex_normals(V, F)
    nv, nf = len(V), len(F)
    uniq, inv = np.unique(np.sort(np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1), axis=0,
                          return_inverse=True)
    inv = inv.reshape(-1)
    a, b = uniq[:, 0], uniq[:, 1]
    mid = 0.5 * (V[a] + V[b])
    proj = lambda q, p, n: q - np.einsum("ij,ij->i", q - p, n)[:, None] * n  # noqa: E731
    mid = 0.25 * mid + 0.75 * 0.5 * (proj(mid, V[a], N[a]) + proj(mid, V[b], N[b]))
    m01, m12, m20 = nv + inv[:nf], nv + inv[nf:2 * nf], nv + inv[2 * nf:]
    F2 = np.concatenate([np.c_[F[:, 0], m01, m20], np.c_[m01, F[:, 1], m12], np.c_[m20, m12, F[:, 2]],
                         np.c_[m01, m12, m20]])
    V2 = np.concatenate([V, mid])
    if FT is None:
        return V2, F2, None, None
    nt = len(UV)
    ut, it = np.unique(np.sort(np.concatenate([FT[:, [0, 1]], FT[:, [1, 2]], FT[:, [2, 0]]]), axis=1), axis=0,
                       return_inverse=True)
    it = it.reshape(-1)
    t01, t12, t20 = nt + it[:nf], nt + it[nf:2 * nf], nt + it[2 * nf:]
    FT2 = np.concatenate([np.c_[FT[:, 0], t01, t20], np.c_[t01, FT[:, 1], t12], np.c_[t20, t12, FT[:, 2]],
                          np.c_[t01, t12, t20]])
    return V2, F2, np.concatenate([UV, 0.5 * (UV[ut[:, 0]] + UV[ut[:, 1]])]), FT2


# --- the normal map's measured relief ----------------------------------------------------------------------------

def _uv_islands(UV, FT, w, h):
    """The UV island (1-based) of each triangle: triangles joined through shared texture positions. Positions are
    welded at 1/1000 texel, so an exporter that repeats a vt per corner still yields whole islands; separate islands
    never share a position."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    key = np.round(UV * [w, h] * 1000).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    t = weld.reshape(-1)[FT]
    n = int(t.max()) + 1
    edges = np.concatenate([t[:, [0, 1]], t[:, [1, 2]]])
    _, comp = connected_components(coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n)),
                                   directed=False)
    return comp[t[:, 0]] + 1


def _texture_space(UV, FT, V, F, w, h, islands=False):
    """The texels the mesh's UV triangles cover, and millimetres per texel (median over triangles). With islands,
    the coverage is each texel's UV island id (0 outside every island) instead of a mask."""
    from PIL import Image, ImageDraw
    px = UV[FT] * [w, h]
    ids = _uv_islands(UV, FT, w, h) if islands else np.ones(len(FT), dtype=np.int64)
    cover = Image.new("I", (w, h), 0)
    draw = ImageDraw.Draw(cover)
    for tri, k in zip(px, ids):
        draw.polygon([(x, h - y) for x, y in tri], fill=int(k))
    cover = np.asarray(cover).astype(np.int32)
    e1, e2 = px[:, 1] - px[:, 0], px[:, 2] - px[:, 0]
    tex_area = np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) / 2
    area3 = np.linalg.norm(_face_normals(V, F, unit=False), axis=1) / 2
    ok = tex_area > 1e-6
    return (cover if islands else cover > 0), float(np.median(np.sqrt(area3[ok] / tex_area[ok])))


def _height_map(normal_rgb, UV, FT, V, F, longest_mm, finest_mm):
    """Integrates the tangent-space normal map (OpenGL: +X along U, +Y along V, as Object Capture writes it) with a
    screened Poisson solve: the height (mm) of the scan's fine detail over its coarse surface, per texel."""
    from scipy.ndimage import binary_erosion, gaussian_filter
    h, w = normal_rgb.shape[:2]
    mask, mm = _texture_space(UV, FT, V, F, w, h)
    n = normal_rgb * 2 - 1
    nz = np.maximum(n[..., 2], 0.2)
    g_col = np.where(mask, -n[..., 0] / nz, 0).astype(np.float32)
    g_row = np.where(mask, n[..., 1] / nz, 0).astype(np.float32)  # image rows run down: -V
    kx = (2 * np.pi * np.fft.rfftfreq(w)).astype(np.float32)[None, :]
    ky = (2 * np.pi * np.fft.fftfreq(h)).astype(np.float32)[:, None]
    k0 = np.float32(2 * np.pi * mm / longest_mm)
    spectrum = -(1j * kx * np.fft.rfft2(g_col) + 1j * ky * np.fft.rfft2(g_row)) / (kx ** 2 + ky ** 2 + k0 ** 2)
    height = np.fft.irfft2(spectrum, s=(h, w)).astype(np.float32) * np.float32(mm)
    del spectrum, g_col, g_row
    height = gaussian_filter(height, max(finest_mm / mm / 2, 0.5))
    inner = binary_erosion(mask, iterations=max(2, int(round(0.4 / mm))))  # seams were integrated apart
    return height * gaussian_filter(inner.astype(np.float32), max(1.0, 0.3 / mm)), mm


def _texture_band(rgb, UV, FT, V, F, finest_mm, longest_mm):
    """The colour texture's luminance between finest_mm and longest_mm (a textile's stitch or weave scale), per
    texel. Each UV island is filtered on its own, normalised by its own coverage, so neither a seam's padding nor a
    neighbouring island packed within the blur radius bleeds in (Codex review, 2026-11-11); the scan's baked shading
    is longer than longest_mm and drops out."""
    from scipy.ndimage import find_objects, gaussian_filter
    h, w = rgb.shape[:2]
    islands, mm = _texture_space(UV, FT, V, F, w, h, islands=True)
    lum = rgb[..., :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    fine, coarse = max(finest_mm / 2 / mm, 0.5), max(longest_mm / 2 / mm, 0.5)
    pad = int(np.ceil(4 * coarse))
    band = np.zeros((h, w), dtype=np.float32)
    for k, box in enumerate(find_objects(islands), start=1):
        if box is None:
            continue
        rows = slice(max(box[0].start - pad, 0), min(box[0].stop + pad, h))
        cols = slice(max(box[1].start - pad, 0), min(box[1].stop + pad, w))
        m = (islands[rows, cols] == k).astype(np.float32)
        lm = lum[rows, cols] * m

        def blur(sigma):
            return gaussian_filter(lm, sigma) / np.maximum(gaussian_filter(m, sigma), 1e-3)
        band[rows, cols] += (blur(fine) - blur(coarse)) * m
    return band


# --- colour regions ----------------------------------------------------------------------------------------------

def _lab(rgb):
    c = np.where(rgb > 0.04045, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)
    xyz = c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    f = np.cbrt(np.maximum(xyz / [0.9505, 1.0, 1.089], 0.008856))
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def _regions(V, F, colours, clusters, min_area, max_regions=40):
    from scipy.cluster.vq import kmeans2
    lab = _lab(colours) * [0.5, 1.0, 1.0]  # shading moves lightness more than hue
    rng = np.random.default_rng(7)
    centres, _ = kmeans2(lab[rng.choice(len(lab), min(len(lab), 40000), replace=False)], clusters, seed=rng,
                         minit="++", iter=30)
    cluster = np.argmin(((lab[:, None] - centres[None]) ** 2).sum(-1), axis=1)
    A = _adjacency(V, F)
    va = _vertex_areas(V, F)
    piece = np.full(len(V), -1)
    count = 0
    for c in range(clusters):
        label, n = _components(cluster == c, A)
        piece[label >= 0] = label[label >= 0] + count
        count += n
    area = np.bincount(piece, va, count)
    body = int(np.argmax(area))
    kept = sorted((p for p in range(count) if p != body and area[p] >= min_area), key=lambda p: -area[p])[:max_regions]
    ids = {body: 0, **{p: i + 1 for i, p in enumerate(kept)}}
    label = np.array([ids.get(p, -1) for p in range(count)])[piece]
    e = _edges(F)
    cross = label[e[:, 0]] != label[e[:, 1]]
    pairs = np.concatenate([label[e[cross]], label[e[cross]][:, ::-1]])
    vn = _vertex_normals(V, F)
    out = []
    for rid in range(len(ids)):
        sel = label == rid
        w = va[sel]
        centre = (V[sel] * w[:, None]).sum(0) / w.sum()
        normal = (vn[sel] * w[:, None]).sum(0)
        normal /= np.linalg.norm(normal) + 1e-20
        rel = V[sel] - centre
        span = rel @ np.linalg.svd(rel * np.sqrt(w)[:, None], full_matrices=False)[2].T
        around = np.unique(pairs[pairs[:, 0] == rid][:, 1])
        out.append({"id": rid, "colour": "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in colours[sel].mean(0)),
                    "area_mm2": round(float(w.sum()), 1), "centre_mm": [round(float(v), 2) for v in centre],
                    "normal": [round(float(v), 3) for v in normal], "length_mm": round(float(np.ptp(span[:, 0])), 2),
                    "width_mm": round(float(np.ptp(span[:, 1])), 2),
                    "flatness_rms_mm": round(float(np.sqrt(np.average(span[:, 2] ** 2, weights=w))), 3),
                    "inside": int(around[0]) if rid and len(around) == 1 and around[0] >= 0 else None})
    return label, out


def _picture(V, F, label, regions, path):
    """The scan from four sides, each region in its own colour with its id written on it."""
    from PIL import Image, ImageDraw
    palette = np.array([[0.75, 0.75, 0.72]] + [np.random.default_rng(i).uniform(0.15, 0.95, 3) for i in range(1, len(regions) + 1)])
    fl = np.where((label[F] == label[F][:, :1]).all(1), label[F[:, 0]], -1)
    colours = np.where(fl[:, None] >= 0, palette[np.clip(fl, 0, None)], 0.5)
    lo, hi = V.min(0), V.max(0)
    centre, radius = (lo + hi) / 2, float(np.linalg.norm(hi - lo) / 2)
    tiles = []
    for name, az, el in (("front", -90, 25), ("right", 0, 25), ("back", 90, 25), ("top", -90, 89)):
        a, b = np.radians([az, el])
        toward = np.array([np.cos(b) * np.cos(a), np.cos(b) * np.sin(a), np.sin(b)])
        fwd = -toward
        right = np.cross(fwd, [0, 0, 1] if abs(toward[2]) < 0.999 else [0, 1, 0])
        right /= np.linalg.norm(right)
        up = np.cross(right, fwd)
        eye = centre + toward * radius * 5
        size, focal = 900, 4.6
        rel = V[F] - eye
        n = _face_normals(V, F)
        vis = np.einsum("ij,ij->i", n, rel.mean(1)) < 0
        z = rel[vis] @ fwd
        x = (rel[vis] @ right) / z * focal * size / 2 + size / 2
        y = -(rel[vis] @ up) / z * focal * size / 2 + size / 2
        shade = 0.55 + 0.45 * np.clip(n[vis] @ (-fwd * 0.8 + up * 0.6), 0, 1)
        rgb = (np.clip(colours[vis] * shade[:, None], 0, 1) * 255).astype(np.uint8)
        im = Image.new("RGB", (size, size), (167, 167, 168))
        d = ImageDraw.Draw(im)
        for i in np.argsort(-z.mean(1)):
            d.polygon([(x[i, 0], y[i, 0]), (x[i, 1], y[i, 1]), (x[i, 2], y[i, 2])], fill=tuple(rgb[i]))
        for r in regions[1:]:
            c = np.asarray(r["centre_mm"]) - eye
            if np.dot(r["normal"], toward) > 0.1:
                zc = c @ fwd
                d.text(((c @ right) / zc * focal * size / 2 + size / 2, -(c @ up) / zc * focal * size / 2 + size / 2),
                       str(r["id"]), fill=(0, 0, 0), stroke_width=2, stroke_fill=(255, 255, 255))
        d.text((8, 8), name, fill=(0, 0, 0))
        tiles.append(im)
    sheet = Image.new("RGB", (1800, 1800))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % 2) * 900, (i // 2) * 900))
    sheet.save(path)


# --- the touch-up ------------------------------------------------------------------------------------------------

class ScanTouchup:
    def __init__(self, scan, colour=None, normal=None, edge_mm=0.4, clusters=6, min_region_mm2=3.0, clean=True):
        """scan: load_scan's trimesh (millimetres, Z up, its UVs kept). colour, normal: the declared files' paths."""
        import trimesh  # noqa: F401  (load_scan's type)
        V = np.asarray(scan.vertices, dtype=np.float64)
        F = np.asarray(scan.faces, dtype=np.int64)
        uv = getattr(scan.visual, "uv", None)
        UV = np.asarray(uv, dtype=np.float64) if uv is not None and len(uv) == len(V) else None
        FT = F.copy() if UV is not None else None
        # Weld positions split at UV seams; every face corner keeps its UV.
        key = np.round(V * 1e6).astype(np.int64)
        _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
        V, F = V[first], inverse.reshape(-1)[F]
        good = np.linalg.norm(_face_normals(V, F, unit=False), axis=1) > 1e-12
        F = F[good]
        FT = FT[good] if FT is not None else None
        self.changes, self.stats = [], {"input_triangles": int(len(F))}
        if clean:
            V, F, FT, pieces = _drop_floaters(V, F, FT)
            V, spikes = _remove_spikes(V, F)
            V, F, FT, holes = _fill_holes(V, F, FT)
            self.stats.update(loose_pieces_removed=pieces, spike_points_moved=spikes, holes_closed=holes)
            for n, text in ((pieces, "loose piece(s) removed"), (spikes, "spike point(s) pulled back into the surface"),
                            (holes, "hole(s) closed")):
                if n:
                    self.changes.append(("changed", f"{n} {text}"))
        e = _edges(F)
        edge = float(np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1).mean())
        levels = 0
        while edge > edge_mm * 1.25 and len(F) * 4 <= MAX_TRIANGLES:
            V, F, UV, FT = _subdivide(V, F, UV, FT)
            edge /= 2
            levels += 1
        self.stats.update(refine_levels=levels, mean_edge_mm=round(edge, 3), triangles=int(len(F)))
        self.V, self.F, self.UV, self.FT = V, F, UV, FT
        self.colour_path, self.normal_path = colour, normal
        self._clusters, self._min_area = clusters, min_region_mm2
        self._label = self._regions = None
        self._flat, self._parts, self._seat, self._texture = [], [], None, None

    def _image(self, path, mode):
        from PIL import Image
        return np.asarray(Image.open(path).convert(mode), dtype=np.float32) / 255

    def regions(self, picture="regions.png"):
        """The colour regions, largest first; 0 is the body. Printed to build.log; picture saved in the run folder."""
        if self._regions is None:
            if self.colour_path is None or self.UV is None:
                raise ValueError("regions need the scan's UVs and its colour map as a declared input")
            colours = np.clip(_per_vertex(_sample(self._image(self.colour_path, "RGB"), self.UV), self.F, self.FT,
                                          len(self.V)), 0, 1)
            self._label, self._regions = _regions(self.V, self.F, colours, self._clusters, self._min_area)
            signature = hashlib.sha256(self._label.astype(np.int32).tobytes()).hexdigest()[:12]
            print(json.dumps({"scan_regions": self._regions, "signature": signature}))
            if picture:
                _picture(self.V, self.F, self._label, self._regions, Path(picture))
        return self._regions

    def _mask(self, ids):
        self.regions(picture=None) if self._regions is None else None
        ids = [ids] if isinstance(ids, (int, np.integer)) else list(ids)
        for i in ids:
            if not 0 < i < len(self._regions):
                raise ValueError(f"no region {i} (1..{len(self._regions) - 1}; 0 is the body)")
        return np.isin(self._label, ids)

    def flatten(self, ids, shape="plane", feather_mm=1.5, max_move_mm=1.0, name="Region"):
        """Moves regions the photos show flat (a card, a label) onto one fitted surface: "plane", or "curved" (a
        quadric) for a bent card. Patches inside them (printed ink) come along; the move fades out over feather_mm
        inside their rim and never exceeds max_move_mm."""
        mask = self._mask(ids)
        A = _adjacency(self.V, self.F)
        outside, n = _components(~mask, A)
        if n > 1:
            mask |= (outside >= 0) & (outside != np.argmax(np.bincount(outside[outside >= 0])))
        self._flat.append((mask, shape, feather_mm, max_move_mm, name))
        return self

    def bead(self, region, diameter_mm=None, proud_mm=None, name="Bead"):
        """A sphere seated on a round region (an eye, a button): by default the region's own size, standing out
        35% of its diameter."""
        self._parts.append(("bead", self._mask(region), diameter_mm, proud_mm, name))
        return self

    def cord(self, region, diameter_mm=None, proud_mm=None, name="Cord"):
        """A round cord laid along a thread-like region (a stitched mustache, a seam), following its own curve."""
        self._parts.append(("cord", self._mask(region), diameter_mm, proud_mm, name))
        return self

    def texture_relief(self, height_mm, regions=None, finest_mm=0.4, longest_mm=3.0, name="Textile"):
        """Raises a textile's stitch or weave pattern from the colour texture: for fabric, knit or crochet the photos
        show in relief that the scan did not capture (its normal map holds almost none). Off unless called; never
        for hard objects, printed graphics or labels. The luminance between finest_mm and longest_mm is normalised
        over the textile and scaled so its peaks stand about height_mm / 2 out and in (lit loops up, shadowed gaps
        down). It goes on `regions` (default: every region not flattened, beaded or corded), fading out over 1 mm
        from those and from the seat band. Listed as assumed."""
        if not 0 < float(height_mm) <= 2:
            raise ValueError("texture_relief height_mm must be above 0 and at most 2")
        if not 0 < finest_mm < longest_mm:
            raise ValueError("texture_relief needs 0 < finest_mm < longest_mm")
        if self.colour_path is None or self.UV is None:
            raise ValueError("texture_relief needs the scan's UVs and its colour map as a declared input")
        self._texture = (float(height_mm), None if regions is None else self._mask(regions), float(finest_mm),
                         float(longest_mm), name)
        return self

    def seat(self, height_mm):
        """Cuts a flat base height_mm above the lowest point and sets it on z = 0."""
        self._seat = float(height_mm)
        return self

    def mesh(self, relief_gain=1.0, relief_longest_mm=8.0, relief_finest_mm=0.3):
        """Runs the recorded steps and returns the closed trimesh. relief_gain 1 adds the normal map's detail at the
        height it measured; 0 adds none. Prints the changes to build.log."""
        import manifold3d as mf
        import trimesh
        V, F = self.V.copy(), self.F
        A = _adjacency(V, F)
        keep_clear = np.zeros(len(V), dtype=bool)
        for mask, *_ in self._flat:
            keep_clear |= mask
        for _, mask, *_ in self._parts:
            keep_clear |= mask
        if relief_gain and self.normal_path and self.UV is not None:
            height, mm = _height_map(self._image(self.normal_path, "RGB"), self.UV, self.FT, V, F,
                                     relief_longest_mm, relief_finest_mm)
            h = _per_vertex(_sample(height, self.UV), F, self.FT, len(V))
            del height
            fade = np.clip(_distance(A, V, keep_clear, 1.0), 0, 1) if keep_clear.any() else np.ones(len(V))
            if self._seat is not None:
                fade *= np.clip(V[:, 2] - V[:, 2].min() - self._seat, 0, 1)
            V = V + (relief_gain * h * fade)[:, None] * _vertex_normals(V, F)
            rms = float(np.sqrt(np.mean(h ** 2)))
            self.stats["relief_measured_rms_mm"] = round(rms, 4)
            self.changes.append(("changed" if relief_gain == 1 else "assumed",
                                 f"surface detail from the scan's normal map, {rms * relief_gain:.2f} mm rms"
                                 + ("" if relief_gain == 1 else f" ({relief_gain:g}x what it measured)")))
        if self._texture is not None:
            height_mm, include, finest, longest, name = self._texture
            band = _texture_band(self._image(self.colour_path, "RGB"), self.UV, self.FT, V, F, finest, longest)
            b = _per_vertex(_sample(band, self.UV), F, self.FT, len(V))
            del band
            allowed = ~keep_clear if include is None else include & ~keep_clear
            fade = np.clip(_distance(A, V, ~allowed, 1.0), 0, 1) if (~allowed).any() else np.ones(len(V))
            if self._seat is not None:
                fade *= np.clip(V[:, 2] - V[:, 2].min() - self._seat, 0, 1)
            scale = float(np.percentile(np.abs(b[allowed]), 90)) if allowed.any() else 0.0
            if scale > 0:
                h = 0.5 * height_mm * np.clip(b / scale, -1, 1)
                V = V + (h * fade)[:, None] * _vertex_normals(V, F)
                self.stats["texture_relief_rms_mm"] = round(float(np.sqrt(np.mean((h * fade)[allowed] ** 2))), 3)
                self.changes.append(("assumed", f"{name}: stitch pattern raised from the colour texture, "
                                                f"{height_mm:g} mm peak to peak, on the textile only"))
        vn = _vertex_normals(V, F)
        for mask, shape, feather, cap, name in self._flat:
            pts = V[mask]
            centre = pts.mean(0)
            axes = np.linalg.svd(pts - centre, full_matrices=False)[2]
            n = axes[2] * (1 if axes[2] @ vn[mask].mean(0) >= 0 else -1)
            u, v, w = (V - centre) @ axes[0], (V - centre) @ axes[1], (V - centre) @ n
            basis = np.c_[np.ones(len(V)), u, v] if shape == "plane" else np.c_[np.ones(len(V)), u, v, u * u, u * v, v * v]
            target = basis @ np.linalg.lstsq(basis[mask], w[mask], rcond=None)[0]
            weight = np.where(mask, np.clip(_distance(A, V, ~mask, feather) / max(feather, 1e-6), 0, 1), 0)
            V = V + np.clip((target - w) * weight, -cap, cap)[:, None] * n
            self.changes.append(("changed", f"{name}: made {'flat' if shape == 'plane' else 'smooth'} "
                                            f"({float(np.sqrt(np.mean((target - w)[mask] ** 2))):.2f} mm rms of scan wobble removed)"))
        vn = _vertex_normals(V, F)
        body = mf.Manifold(mf.Mesh(vert_properties=np.ascontiguousarray(V, np.float32),
                                   tri_verts=np.ascontiguousarray(F, np.uint32)))
        if body.status() != mf.Error.NoError:
            raise ValueError(f"the cleaned scan is not a closed solid ({body.status().name})")
        shapes = []
        for kind, mask, d, proud, name in self._parts:
            pts, nrm = V[mask], vn[mask]
            centre = pts.mean(0)
            n = nrm.mean(0)
            n /= np.linalg.norm(n) + 1e-20
            flat = (pts - centre) - np.outer((pts - centre) @ n, n)
            if kind == "bead":
                d = float(d or 2 * np.sqrt(2) * np.sqrt((flat ** 2).sum(1).mean()))
                proud = 0.35 * d if proud is None else float(proud)
                surface = V[np.argmin(np.linalg.norm(V - centre, axis=1))]
                shapes.append(mf.Manifold.sphere(d / 2, 64).translate(tuple(surface + (proud - d / 2) * n)))
                self.changes.append(("assumed", f"{name}: {d:.1f} mm bead, {proud:.1f} mm proud, placed from the scan's colour"))
                continue
            axis = np.linalg.svd(flat, full_matrices=False)[2][0]
            side = np.cross(n, axis)
            s, t = flat @ axis, flat @ side
            lo, hi = np.percentile(s, [1, 99])
            step = max(0.5, (hi - lo) / 24)
            stations, widths = [], []
            for a in np.arange(lo, hi + 1e-9, step):
                sel = np.abs(s - a) <= 0.75 * step
                if sel.sum() >= 3:
                    stations.append((a, np.median(t[sel])))
                    widths.append(np.percentile(t[sel], 95) - np.percentile(t[sel], 5))
            st = np.array(stations)
            if len(st) >= 5:
                st[:, 1] = np.convolve(np.pad(st[:, 1], 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
            d = float(d or np.median(widths))
            proud = 0.45 * d if proud is None else float(proud)
            path = centre + st[:, :1] * axis + st[:, 1:2] * side
            near = [int(np.argmin(np.linalg.norm(flat - (p - centre - ((p - centre) @ n) * n), axis=1))) for p in path]
            path = path + ((pts[near] - path) @ n)[:, None] * n
            normals = nrm[near] / (np.linalg.norm(nrm[near], axis=1, keepdims=True) + 1e-20)
            m = len(path)
            taper = np.minimum(1.0, 0.7 + 0.3 * np.minimum(np.arange(m), np.arange(m)[::-1]) / max(1, min(3, m // 2)))
            radii = d / 2 * taper
            centres = path + (proud * taper - radii)[:, None] * normals
            balls = [mf.Manifold.sphere(float(r), 32).translate(tuple(c)) for c, r in zip(centres, radii)]
            shapes.append(mf.Manifold.batch_boolean([mf.Manifold.batch_hull([balls[i], balls[i + 1]]) for i in range(m - 1)]
                                                    or balls, mf.OpType.Add))
            self.changes.append(("assumed", f"{name}: {d:.1f} mm cord, {hi - lo:.0f} mm along the scan's line, {proud:.1f} mm proud"))
        if shapes:
            body = mf.Manifold.batch_boolean([body] + shapes, mf.OpType.Add)
        if self._seat is not None:
            cut = float(body.bounding_box()[2]) + self._seat
            body = body.trim_by_plane((0.0, 0.0, 1.0), cut).translate((0.0, 0.0, -cut))
            self.changes.append(("changed", f"flat seat cut {self._seat:g} mm up"))
        out = body.to_mesh()
        result = trimesh.Trimesh(np.asarray(out.vert_properties)[:, :3], np.asarray(out.tri_verts), process=False)
        print(json.dumps({"scan_touchup": {"changes": [{"tag": t, "text": x} for t, x in self.changes], "stats": self.stats}}))
        return result


def scan_touchup_factory(inputs):
    """scan_touchup(scan, colour=None, normal=None, **settings) for build(): map names are declared inputs."""
    declared = dict(inputs)

    def scan_touchup(scan, *, colour=None, normal=None, edge_mm=0.4, clusters=6, min_region_mm2=3.0, clean=True):
        for name in (colour, normal):
            if name is not None and name not in declared:
                raise ValueError(f"scan_touchup: {name!r} is not a declared input")
        return ScanTouchup(scan, declared.get(colour) if colour else None, declared.get(normal) if normal else None,
                           edge_mm=edge_mm, clusters=clusters, min_region_mm2=min_region_mm2, clean=clean)
    return scan_touchup
