"""Independent geometry checks, six orthographic views, a perspective view and triangle-exact surface separation."""
from pathlib import Path
import math
import numpy as np
import trimesh
import manifold3d as mf
from PIL import Image, ImageDraw, ImageFont


def mesh(file):
    m = trimesh.load(file, force='mesh', file_type='stl')
    m.merge_vertices()
    if not len(m.faces) or len(m.faces) > 250000 or not np.isfinite(m.vertices).all():
        raise ValueError('Mesh must have finite vertices and 1..250000 triangles.')
    return m


def manifold(m):
    return mf.Manifold(mf.Mesh(np.asarray(m.vertices, dtype=np.float32), np.asarray(m.faces, dtype=np.uint32)))


def inspect(request):
    from build123d import import_step
    base = Path(request['output']) / request['name']
    m = mesh(str(base) + '.stl')
    step = import_step(str(base) + '.step') if request.get('mode', 'solid') == 'solid' else None
    mm = manifold(m)
    bounds = m.bounds.tolist()
    sb = step.bounding_box() if step is not None else None
    step_bounds = [list(sb.min), list(sb.max)] if sb is not None else None
    checks = {'watertight': bool(m.is_watertight), 'winding_consistent': bool(m.is_winding_consistent), 'positive_volume': bool(m.is_volume),
              'manifold': mm.status() == mf.Error.NoError, 'step_valid': bool(step.is_valid) if step is not None else None,
              # A solid design whose STEP holds only shells (seen after rounding a sketch by offsetting it out and
              # back) is not the B-rep it claims to be, however good its mesh looks.
              'step_solids': bool(len(step.solids()) >= 1) if step is not None else None,
              'stl_step_bounds_agree': bool(np.max(np.abs(m.bounds - np.array(step_bounds))) <= 0.2) if step_bounds is not None else None}
    return {'valid': all(v for v in checks.values() if v is not None), 'units': 'mm', 'bounds_mm': bounds,
            'size_mm': m.extents.tolist(), 'volume_mm3': float(m.volume) if m.is_volume else None,
            'step_volume_mm3': float(step.volume) if step is not None else None, 'solid_count': len(step.solids()) if step is not None else len(m.split(only_watertight=True)),
            'mesh_components': len(m.split(only_watertight=False)), 'checks': checks,
            'renders': render(m, base.parent / (base.name + '.renders'))}


def render(m, folder):
    folder.mkdir(exist_ok=True)
    tri, centres, normals = m.triangles, m.triangles.mean(axis=1), m.face_normals
    # Keep only boundaries, creases and view silhouettes, not every STL triangle.
    # Each stroke is painted with its triangle so nearer surfaces hide rear edges.
    edges = np.sort(m.faces[:, [[0, 1], [1, 2], [2, 0]]].reshape(-1, 2), axis=1)
    _, inverse, counts = np.unique(edges, axis=0, return_inverse=True, return_counts=True)
    ordered = np.argsort(inverse, kind='stable')
    starts = np.cumsum(counts) - counts
    paired = np.flatnonzero(counts == 2)
    a, b = ordered[starts[paired]] // 3, ordered[starts[paired] + 1] // 3
    feature = counts != 2
    feature[paired] = np.einsum('ij,ij->i', normals[a], normals[b]) < math.cos(math.radians(35))
    views = [('front', 0, 2, 1, 1), ('back', 0, 2, 1, -1), ('left', 1, 2, 0, -1),
             ('right', 1, 2, 0, 1), ('top', 0, 1, 2, 1), ('bottom', 0, 1, 2, -1)]
    images, paths = [], {}
    for name, u, v, depth, sign in views:
        im = Image.new('RGB', (800, 800), '#f5f5f2')
        draw = ImageDraw.Draw(im)
        xy = tri[:, :, [u, v]].copy()
        xy[:, :, 0] *= sign * (-1 if depth == 1 else 1)
        lo, hi = xy.min(axis=(0, 1)), xy.max(axis=(0, 1))
        extent = max(hi - lo)
        if extent <= 0: raise ValueError('Empty mesh extent')
        xy = (xy - (lo + hi) / 2) * (680 / extent) + 400
        xy[:, :, 1] = 800 - xy[:, :, 1]
        light = np.zeros(3); light[depth] = sign * .85; light[v] = .45; light[u] = -.3 * sign * (-1 if depth == 1 else 1)
        light /= np.linalg.norm(light)
        shades = .4 + .6 * np.clip(normals @ light, 0, 1)
        # Parallel interior walls otherwise get exactly the same flat lighting as
        # the near wall, concealing openings that look onto the back of a cavity.
        depths = tri[:, :, depth] * sign
        span = float(np.ptp(depths))
        near = (centres[:, depth] * sign - depths.min()) / span if span > 0 else np.ones(len(tri))
        shades *= .76 + .24 * near
        outlines = feature.copy()
        facing = normals[:, depth] * sign > 1e-8
        outlines[paired] |= facing[a] != facing[b]
        outlines = outlines[inverse].reshape(-1, 3)
        for i in np.argsort(centres[:, depth] * sign, kind='stable'):
            draw.polygon([tuple(a) for a in xy[i]], fill=tuple(int(k * shades[i]) for k in (79, 166, 186)))
            for j in np.flatnonzero(outlines[i]):
                draw.line([tuple(xy[i, j]), tuple(xy[i, (j + 1) % 3])], fill=(27, 62, 70), width=2)
        draw.text((24, 22), name + ' | ' + ', '.join(f'{x:.2f}' for x in m.extents) + ' mm', fill='black')
        file = folder / (name + '.png'); im.save(file); paths[name] = str(file); images.append(im)
    # The view a person judges a shape from: three-quarter, in perspective, large on the sheet beside the six.
    big = perspective(m, 1600)
    label = 'perspective, from the front right and above | ' + ' x '.join(f'{x:.1f}' for x in m.extents) + ' mm'
    ImageDraw.Draw(big).text((28, 24), label, fill='black', font=ImageFont.load_default(size=30))
    file = folder / 'perspective.png'; big.resize((800, 800), Image.LANCZOS).save(file); paths['perspective'] = str(file)
    sheet = Image.new('RGB', (1600 + 2 * 534, 1602), 'white')
    sheet.paste(big, (0, 0))
    for i, im in enumerate(images): sheet.paste(im.resize((534, 534), Image.LANCZOS), (1600 + (i % 2) * 534, (i // 2) * 534))
    sheet.save(folder / 'contact.png'); paths['contact'] = str(folder / 'contact.png')
    return paths


def perspective(m, size=1600, azimuth=35.0, elevation=26.0):
    """A three-quarter view in true perspective with a depth buffer (large flat faces defeat depth sorting at an
    angle). Seen from the front (-Y) turned `azimuth` degrees towards +X and raised `elevation` degrees, through a
    28 degree lens, framed to fill the picture. Smooth shading across facets that meet within 40 degrees, so a
    lofted or filleted surface reads as one surface and a real edge stays an edge; outlines where the surface steps
    in depth or creases by more than 35 degrees. Every array operation is over all triangles at once."""
    V, F, N = np.asarray(m.vertices, float), np.asarray(m.faces), np.asarray(m.face_normals, float)
    centre, radius = m.bounds.mean(axis=0), max(float(np.linalg.norm(m.extents)) / 2, 1e-9)
    az, el = math.radians(azimuth), math.radians(elevation)
    to_eye = np.array([math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)])
    d = -to_eye
    r = np.cross(d, [0, 0, 1.0]); r /= np.linalg.norm(r)
    u = np.cross(r, d)
    eye = centre + to_eye * radius / math.sin(math.radians(14)) * 1.06
    q = V - eye
    zc = q @ d
    tx, ty = (q @ r) / zc, (q @ u) / zc
    zoom = 0.86 * size / max(float(np.ptp(tx)), float(np.ptp(ty)), 1e-12)
    X = size / 2 + zoom * (tx - (tx.min() + tx.max()) / 2)
    Y = size / 2 - zoom * (ty - (ty.min() + ty.max()) / 2)
    W = 1.0 / zc                                       # inverse depth is affine across a triangle on screen
    # light: key from the upper left of the viewer, a weaker fill from the right
    key = -0.55 * r + 0.75 * u - 0.45 * d; key /= np.linalg.norm(key)
    fill = 0.8 * r + 0.15 * u - 0.6 * d; fill /= np.linalg.norm(fill)
    lum = lambda n: 0.26 + 0.58 * np.clip(n @ key, 0, None) + 0.2 * np.clip(n @ fill, 0, None)
    vn = np.asarray(m.vertex_normals, float)
    corner = vn[F]                                     # (T, 3, 3): use the vertex normal only where it is this face's
    smooth = np.einsum('tkj,tj->tk', corner, N) > 0.766
    L = np.where(smooth, lum(corner.reshape(-1, 3)).reshape(-1, 3), lum(N)[:, None])
    facing = np.einsum('ij,ij->i', N, V[F].mean(axis=1) - eye) < 0
    if m.is_watertight:
        front = facing                                 # a closed solid: its back faces are never seen
    else:                                              # an open scan is seen from both sides: light the side that faces the eye
        front = np.ones(len(F), bool)
        L = np.where(facing[:, None], L, np.where(smooth, lum(-corner.reshape(-1, 3)).reshape(-1, 3), lum(-N)[:, None]))
        N = np.where(facing[:, None], N, -N)
    x, y, w, L = X[F][front], Y[F][front], W[F][front], L[front]
    Nf = N[front]
    det = (x[:, 1] - x[:, 0]) * (y[:, 2] - y[:, 0]) - (x[:, 2] - x[:, 0]) * (y[:, 1] - y[:, 0])
    ok = np.abs(det) > 1e-12
    x, y, w, L, Nf, det = x[ok], y[ok], w[ok], L[ok], Nf[ok], det[ok]
    if not len(x):                                     # nothing faces the eye (a mesh seen exactly edge-on)
        return Image.new('RGB', (size, size), '#f5f5f2')
    def plane(a):                                      # a(px, py) = a0 + gx (px - x0) + gy (py - y0)
        gx = ((a[:, 1] - a[:, 0]) * (y[:, 2] - y[:, 0]) - (a[:, 2] - a[:, 0]) * (y[:, 1] - y[:, 0])) / det
        gy = ((a[:, 2] - a[:, 0]) * (x[:, 1] - x[:, 0]) - (a[:, 1] - a[:, 0]) * (x[:, 2] - x[:, 0])) / det
        return a[:, 0], gx, gy
    w0, wx, wy = plane(w)
    l0, lx, ly = plane(L)
    # rows each triangle covers (pixel centres at +0.5), then the columns of each row
    r0 = np.clip(np.ceil(y.min(axis=1) - 0.5), 0, size - 1).astype(np.int64)
    r1 = np.clip(np.floor(y.max(axis=1) - 0.5), 0, size - 1).astype(np.int64)
    rows = np.maximum(r1 - r0 + 1, 0)
    t = np.repeat(np.arange(len(x)), rows)
    row = r0[t] + (np.arange(len(t)) - np.repeat(np.cumsum(rows) - rows, rows))
    yc = row + 0.5
    lo, hi = np.full(len(t), np.inf), np.full(len(t), -np.inf)
    for a, b in ((0, 1), (1, 2), (2, 0)):
        ya, yb, xa, xb = y[t, a], y[t, b], x[t, a], x[t, b]
        crosses = ((ya <= yc) & (yc < yb)) | ((yb <= yc) & (yc < ya))
        xi = xa + (yc - ya) * (xb - xa) / np.where(crosses, yb - ya, 1.0)
        lo, hi = np.where(crosses, np.minimum(lo, xi), lo), np.where(crosses, np.maximum(hi, xi), hi)
    c0 = np.clip(np.ceil(np.where(np.isfinite(lo), lo, 0) - 0.5), 0, size - 1).astype(np.int64)
    c1 = np.clip(np.floor(np.where(np.isfinite(hi), hi, -1) - 0.5), -1, size - 1).astype(np.int64)
    cols = np.maximum(c1 - c0 + 1, 0)
    cols[~np.isfinite(lo)] = 0
    k = np.repeat(np.arange(len(t), dtype=np.int32), cols)
    px = (c0[k] + (np.arange(len(k)) - np.repeat(np.cumsum(cols) - cols, cols))).astype(np.int32)
    tri, py = t[k].astype(np.int32), row[k].astype(np.int32)
    del k
    dx, dy = (px + 0.5 - x[tri, 0]).astype(np.float32), (py + 0.5 - y[tri, 0]).astype(np.float32)
    wv = w0[tri] + wx[tri] * dx + wy[tri] * dy
    pix = py.astype(np.int64) * size + px
    del px, py
    zbuf = np.zeros(size * size)
    np.maximum.at(zbuf, pix, wv)
    win = wv >= zbuf[pix]
    tid = np.full(size * size, -1, dtype=np.int32)
    tid[pix[win]] = tri[win]
    shade = np.zeros(size * size, dtype=np.float32)
    shade[pix[win]] = np.clip(l0[tri[win]] + lx[tri[win]] * dx[win] + ly[tri[win]] * dy[win], 0, 1)
    del tri, dx, dy, wv, pix, win
    tid, zbuf, shade = tid.reshape(size, size), zbuf.reshape(size, size), shade.reshape(size, size)
    solid = tid >= 0
    ti = np.where(solid, tid, 0)
    gx, gy, nrm = wx[ti], wy[ti], Nf[ti].astype(np.float32)
    edge = np.zeros((size, size), bool)
    for sy, sx in ((0, 1), (1, 0), (0, -1), (-1, 0)):
        other = np.roll(solid, (-sy, -sx), axis=(0, 1))
        wj = np.roll(zbuf, (-sy, -sx), axis=(0, 1))
        nj = np.roll(nrm, (-sy, -sx), axis=(0, 1))
        inside = np.ones((size, size), bool)
        if sx == 1: inside[:, -1] = False
        if sx == -1: inside[:, 0] = False
        if sy == 1: inside[-1, :] = False
        if sy == -1: inside[0, :] = False
        step = np.abs(wj - (zbuf + gx * sx + gy * sy)) > 1.6 * zbuf / zoom
        crease = np.einsum('ijk,ijk->ij', nrm, nj) < math.cos(math.radians(35))
        edge |= solid & inside & ((~other) | (other & (wj < zbuf) & step) | (other & crease & (sx + sy > 0)))
    edge |= np.roll(edge, 1, axis=0) & solid | np.roll(edge, 1, axis=1) & solid   # two pixels wide before scaling down
    del gx, gy, nrm, ti
    rgb = np.empty((size, size, 3), dtype=np.float32)
    ramp = np.linspace(0, 1, size)[:, None]
    for c, (base, dark, top, bottom) in enumerate(((79, 22, 247, 240), (166, 46, 247, 240), (186, 52, 244, 238))):
        rgb[:, :, c] = np.where(solid, base * shade + dark * (1 - shade), top + (bottom - top) * ramp)
    rgb[edge] = (27, 62, 70)
    return Image.fromarray(rgb.clip(0, 255).astype(np.uint8), 'RGB')


def triangle_distance(a, b):
    """Distance for one A triangle against N B triangles: vertex/face and all 9 edge pairs."""
    n = len(b)
    distances = []
    for i in range(3):
        q = trimesh.triangles.closest_point(b, np.repeat(a[i][None, :], n, axis=0))
        distances.append(np.linalg.norm(q - a[i], axis=1))
        q = trimesh.triangles.closest_point(np.repeat(a[None, :, :], n, axis=0), b[:, i, :])
        distances.append(np.linalg.norm(q - b[:, i, :], axis=1))
    for i in range(3):
        u = a[(i + 1) % 3] - a[i]
        for j in range(3):
            v = b[:, (j + 1) % 3] - b[:, j]
            w = a[i] - b[:, j]
            aa = np.dot(u, u); bb = v @ u; cc = np.einsum('ij,ij->i', v, v)
            dd = w @ u; ee = np.einsum('ij,ij->i', v, w)
            denom = aa * cc - bb * bb
            s = np.clip(np.divide(bb * ee - cc * dd, denom, out=np.zeros(n), where=denom > 1e-20), 0, 1)
            t = np.clip((bb * s + ee) / np.maximum(cc, 1e-30), 0, 1)
            s = np.clip((bb * t - dd) / max(aa, 1e-30), 0, 1)
            distances.append(np.linalg.norm(w + s[:, None] * u - t[:, None] * v, axis=1))
    return float(np.min(distances))


def minimum_gap(a, b):
    # AABB pruning is complete: every candidate closer than the current upper bound has intersecting expanded boxes.
    if len(a.faces) > len(b.faces): a, b = b, a
    _, d, _ = trimesh.proximity.closest_point(b, a.vertices[:32])
    best = float(d.min())
    if best <= 1e-8: return 0.0
    tree = b.triangles_tree
    pairs = 0
    for tri in a.triangles:
        lo, hi = tri.min(0) - best, tri.max(0) + best
        indices = list(tree.intersection(np.r_[lo, hi]))
        pairs += len(indices)
        if pairs > 10000000: raise ValueError('Fit distance exceeds the 10-million triangle-pair budget; simplify the meshes.')
        if indices: best = min(best, triangle_distance(tri, b.triangles[indices]))
        if best <= 1e-8: return 0.0
    return best


def fit(request):
    a, b = mesh(request['model']), mesh(request['reference'])
    transform = request.get('transform', {})
    if not isinstance(transform, dict) or set(transform) - {'translation_mm', 'rotation_deg'}:
        raise ValueError('transform supports only explicit rigid translation_mm and rotation_deg; scaling is never implicit.')
    translation = np.asarray(transform.get('translation_mm', [0, 0, 0]), dtype=float)
    rotation = np.asarray(transform.get('rotation_deg', [0, 0, 0]), dtype=float)
    if translation.shape != (3,) or rotation.shape != (3,) or not np.isfinite(np.r_[translation, rotation]).all():
        raise ValueError('Transform requires finite three-number vectors.')
    matrix = trimesh.transformations.euler_matrix(*np.radians(rotation), axes='sxyz'); matrix[:3, 3] = translation
    b.apply_transform(matrix)
    ma, mb = manifold(a), manifold(b)
    if not a.is_volume or not b.is_volume or ma.status() != mf.Error.NoError or mb.status() != mf.Error.NoError:
        raise ValueError('Fit checks require positively wound watertight manifold STL meshes; repair open scans explicitly before checking.')
    overlap = ma ^ mb
    if overlap.status() != mf.Error.NoError: raise ValueError('Mesh interference Boolean failed.')
    volume = float(overlap.volume())
    gap = 0.0 if volume > 1e-8 else minimum_gap(a, b)
    clearance = request.get('clearance_mm', 0)
    return {'units': 'mm', 'interference_volume_mm3': volume, 'minimum_gap_mm': gap,
            'clearance_mm': clearance, 'clear': volume <= 1e-8 and gap + 1e-8 >= clearance,
            'transform': {'translation_mm': translation.tolist(), 'rotation_deg': rotation.tolist()},
            'method': 'Manifold3D float32 interference; float64 triangle surface distance (vertex/face and edge/edge)',
            'reference_rescaled': False}
