"""Independent geometry checks, six orthographic views and triangle-exact surface separation."""
from pathlib import Path
import math
import numpy as np
import trimesh
import manifold3d as mf
from PIL import Image, ImageDraw


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
              'stl_step_bounds_agree': bool(np.max(np.abs(m.bounds - np.array(step_bounds))) <= 0.2) if step_bounds is not None else None}
    return {'valid': all(v for v in checks.values() if v is not None), 'units': 'mm', 'bounds_mm': bounds,
            'size_mm': m.extents.tolist(), 'volume_mm3': float(m.volume) if m.is_volume else None,
            'step_volume_mm3': float(step.volume) if step is not None else None, 'solid_count': len(step.solids()) if step is not None else len(m.split(only_watertight=True)),
            'mesh_components': len(m.split(only_watertight=False)), 'checks': checks,
            'renders': render(m, base.parent / (base.name + '.renders'))}


def render(m, folder):
    folder.mkdir(exist_ok=True)
    tri, centres, normals = m.triangles, m.triangles.mean(axis=1), m.face_normals
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
        for i in np.argsort(centres[:, depth] * sign):
            draw.polygon([tuple(a) for a in xy[i]], fill=tuple(int(k * shades[i]) for k in (79, 166, 186)))
        draw.text((24, 22), name + ' | ' + ', '.join(f'{x:.2f}' for x in m.extents) + ' mm', fill='black')
        file = folder / (name + '.png'); im.save(file); paths[name] = str(file); images.append(im)
    sheet = Image.new('RGB', (1600, 2400), 'white')
    for i, im in enumerate(images): sheet.paste(im, ((i % 2) * 800, (i // 2) * 800))
    sheet.save(folder / 'contact.png'); paths['contact'] = str(folder / 'contact.png')
    return paths


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
