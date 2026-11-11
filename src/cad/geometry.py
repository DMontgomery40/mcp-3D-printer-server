"""Independent geometry checks, six orthographic views and triangle-exact surface separation."""
from pathlib import Path
import json
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
    try:
        assembly = bodies(step, request) if step is not None else None
    except Exception as e:   # a failed measurement must not cost the person the export; it is reported, not passed
        assembly = {'error': f'{type(e).__name__}: {e}'[:300]}
    return {'valid': all(v for v in checks.values() if v is not None), 'units': 'mm', 'bounds_mm': bounds,
            'size_mm': m.extents.tolist(), 'volume_mm3': float(m.volume) if m.is_volume else None,
            'step_volume_mm3': float(step.volume) if step is not None else None, 'solid_count': len(step.solids()) if step is not None else len(m.split(only_watertight=True)),
            'mesh_components': len(m.split(only_watertight=False)), 'checks': checks,
            **evidence(assembly),
            'renders': render(m, base.parent / (base.name + '.renders'))}


# Starting print-in-place gap between separate bodies: Prusa's first value for movable parts is "at least 0.3 mm"
# (design guidance, fdm_fit [F3]). A script sets its own with a literal P["print_in_place_clearance_mm"].
PIP_CLEARANCE_MM = 0.3


def clearance_setting(request):
    try:
        params = json.loads(Path(request['parameters']).read_text()) if request.get('parameters') else {}
    except (OSError, ValueError):
        params = {}
    value = params.get('print_in_place_clearance_mm') if isinstance(params, dict) else None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 10:
        return float(value), 'P["print_in_place_clearance_mm"]'
    return PIP_CLEARANCE_MM, 'default: Prusa\'s "at least 0.3 mm" for movable parts (fdm_fit)'


def bodies(step, request, budget_s=20.0):
    """Every pair of solids in the exported STEP: true closest approach (screened on tessellations, measured on the
    B-rep), overlap, and whether each labelled body the script returned is still one solid. Council 2026-11-11 (scan-to-make #734): chainmail links
    fused at 48 interfaces, a pawl grazing its wheel while a severed bar kept the solid count right, discs starting in
    mid-air, all with valid: true."""
    import time
    from build123d import Compound
    clearance, source = clearance_setting(request)
    started = time.monotonic()
    # Declared bodies: the top-level children of a returned Compound, named by their labels.
    declared, names = [], []
    children = list(step.children) if isinstance(step, Compound) else []
    # STEP import names an unlabelled shape after its type ("SOLID", "COMPOUND"): only the script's own labels declare
    labelled = lambda c: bool(c.label) and c.label != type(c).__name__.upper() and c.label.upper() not in ('SOLID', 'COMPOUND', 'COMPSOLID', 'SHELL')
    if children and all(labelled(c) for c in children):
        for child in children:
            pieces = child.solids()
            declared.append({'body': child.label, 'solids': len(pieces)})
            names += [child.label if len(pieces) == 1 else f'{child.label} piece {k + 1}' for k in range(len(pieces))]
        solids = [s for c in children for s in c.solids()]
    else:
        solids = list(step.solids())
        names = [f'solid {k + 1}' for k in range(len(solids))]
    boxes = [s.bounding_box() for s in solids]
    near = max(0.5, clearance + 0.2)
    def where(s):
        b = s.bounding_box()
        return [round((b.min.X + b.max.X) / 2, 3), round((b.min.Y + b.max.Y) / 2, 3), round(b.min.Z, 3)]
    # Screen every near pair on tessellations (Manifold min_gap, chord error <= 0.01 mm), then measure each pair that
    # comes within the clearance + 0.02 mm, and the closest, exactly on the B-rep (OCC BRepExtrema) for the reported gap.
    def solid_manifold(s):
        v, f = s.tessellate(0.01, 0.1)
        t = trimesh.Trimesh(np.array([[p.X, p.Y, p.Z] for p in v], dtype=float), np.array(f, dtype=np.int64), process=True)
        t.merge_vertices()
        return manifold(t)
    meshes = [None] * len(solids)
    fused, close, closest, measured, skipped, screen = [], [], None, 0, 0, None
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            a, b = boxes[i], boxes[j]
            gap = math.sqrt(sum(max(0.0, lo2 - hi1, lo1 - hi2) ** 2 for lo1, hi1, lo2, hi2 in
                                ((a.min.X, a.max.X, b.min.X, b.max.X), (a.min.Y, a.max.Y, b.min.Y, b.max.Y), (a.min.Z, a.max.Z, b.min.Z, b.max.Z))))
            if gap >= near: continue
            if time.monotonic() - started > budget_s:
                skipped += 1
                continue
            measured += 1
            for k in (i, j):
                if meshes[k] is None: meshes[k] = solid_manifold(solids[k])
            if meshes[i].status() == mf.Error.NoError and meshes[j].status() == mf.Error.NoError:
                d = meshes[i].min_gap(meshes[j], near)
            else:   # a tessellation that does not close: measure this pair on the B-rep alone
                d = solids[i].distance_to(solids[j])
            holds = lambda x, y: all(getattr(x.min, c) <= getattr(y.min, c) and getattr(y.max, c) <= getattr(x.max, c) for c in 'XYZ')
            if d > 1e-6 and (holds(a, b) or holds(b, a)) and getattr(solids[i] & solids[j], 'volume', 0.0) > 1e-6:
                d = 0.0   # one wholly inside the other: the surfaces never meet
            if d >= near: continue
            if screen is None or d < screen[0]: screen = (d, i, j)
            if d < clearance + 0.02:
                if len(fused) + len(close) < 16:
                    exact, pa, pb = solids[i].distance_to_with_closest_points(solids[j])
                    d = 0.0 if d == 0.0 else exact
                    at = [round((pa.X + pb.X) / 2, 3), round((pa.Y + pb.Y) / 2, 3), round((pa.Z + pb.Z) / 2, 3)]
                else:   # past 16 flagged pairs: the screened gap, located at the middle of where the boxes meet
                    at = [round((max(getattr(a.min, c), getattr(b.min, c)) + min(getattr(a.max, c), getattr(b.max, c))) / 2, 3) for c in 'XYZ']
                row = {'a': names[i], 'b': names[j], 'gap_mm': round(d, 4), 'at': at}
                if closest is None or d < closest['gap_mm']: closest = row
                if d <= 1e-6: fused.append(row)
                elif d < clearance - 1e-9: close.append(row)
    if closest is None and screen is not None:
        d0, i, j = screen
        exact, pa, pb = solids[i].distance_to_with_closest_points(solids[j])
        closest = {'a': names[i], 'b': names[j], 'gap_mm': round(exact, 4), 'at': [round((pa.X + pb.X) / 2, 3), round((pa.Y + pb.Y) / 2, 3), round((pa.Z + pb.Z) / 2, 3)]}
    bed = min((b.min.Z for b in boxes), default=0.0)
    above = [{'solid': names[k], 'starts_mm_above_bed': round(boxes[k].min.Z - bed, 3), 'at': where(solids[k])}
             for k in range(len(solids)) if boxes[k].min.Z - bed > 0.05]
    severed = [d for d in declared if d['solids'] != 1]
    problems = ([f'{r["a"]} and {r["b"]} touch or overlap at {r["at"]}: they print as one piece' for r in fused[:8]] +
                [f'{r["a"]} and {r["b"]} are {r["gap_mm"]} mm apart at {r["at"]}, under the {clearance} mm print-in-place clearance: they weld when printed' for r in close[:8]] +
                [f'body "{d["body"]}" is {d["solids"]} separate solids: something cuts it apart' if d['solids'] > 1 else f'body "{d["body"]}" has no solid' for d in severed] +
                [f'{a["solid"]} starts {a["starts_mm_above_bed"]} mm above the bed: its first layer is printed on air' for a in above[:8]])
    if skipped:
        problems.append(f'{skipped} near pair(s) were not measured within the {budget_s:.0f} s budget')
    return {'solids': len(solids), 'clearance_mm': clearance, 'clearance_source': source,
            'declared_bodies': declared or None, 'pairs_measured': measured, 'pairs_not_measured': skipped,
            'fused': fused, 'too_close': close, 'closest': closest if closest and closest['gap_mm'] < near else None,
            'above_bed': above, 'severed': severed, 'problems': problems,
            'seconds': round(time.monotonic() - started, 3)}


def evidence(assembly):
    """What this result does and does not establish, so valid geometry is never read as a working part."""
    checked = ['the exported mesh is closed, manifold and consistently wound, and the STEP agrees with it (valid, checks)',
               'bounds, size, volumes and solid count of the exported files']
    not_checked = ['fit to the real object or a mating part (use cad_check_fit per state)',
                   'strength, stiffness or how it holds under load',
                   'motion, articulated poses and snap or flex behaviour',
                   'printing: supports, bridges and bed adhesion are the slicer\'s answer']
    if assembly is None:
        not_checked.append('gaps between separate bodies (mesh mode has no solids)')
        return {'checked': checked, 'not_checked': not_checked, 'problems': []}
    if 'error' in assembly:
        not_checked.append('gaps between separate bodies: the measurement failed (' + assembly['error'] + ')')
        return {'bodies': assembly, 'checked': checked, 'not_checked': not_checked, 'problems': ['bodies could not be measured: ' + assembly['error']]}
    if assembly['solids'] > 1:
        checked.append(f'the closest approach of every pair of the {assembly["solids"]} solids against a {assembly["clearance_mm"]} mm print-in-place clearance ({assembly["clearance_source"]}), and whether each solid starts on the bed (bodies; failures are in problems)')
    else:
        checked.append('the single solid starts on the bed (bodies)')
    if assembly['declared_bodies']:
        checked.append('whether each labelled body is exactly one solid (bodies.declared_bodies; failures are in problems)')
    elif assembly['solids'] > 1:
        not_checked.append('which solids are meant to be separate bodies: return Compound(children=[...]) with a label on each body so a severed piece cannot pass for one')
    return {'bodies': assembly, 'problems': assembly['problems'], 'checked': checked, 'not_checked': not_checked}


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
