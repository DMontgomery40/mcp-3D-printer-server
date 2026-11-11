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
# (design guidance, fdm_fit [F3]). A script sets its own with a literal P["print_in_place_clearance_mm"], and says
# its bodies are shown assembled (not printed in place) with P["print_in_place"] = False.
PIP_CLEARANCE_MM = 0.3
BED_TOLERANCE_MM = 0.05
SCREEN_ANGLE = 0.1      # tessellation angular deflection (radians) for the gap screen
EXACT_CAP = 32          # exact B-rep distance calls per result


def clearance_setting(request):
    try:
        params = json.loads(Path(request['parameters']).read_text()) if request.get('parameters') else {}
    except (OSError, ValueError):
        params = {}
    params = params if isinstance(params, dict) else {}
    value = params.get('print_in_place_clearance_mm')
    in_place = params.get('print_in_place', True) is not False
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 10:
        return float(value), 'P["print_in_place_clearance_mm"]', in_place
    return PIP_CLEARANCE_MM, 'default: Prusa\'s "at least 0.3 mm" for movable parts (fdm_fit)', in_place


def bodies(step, request, budget_s=20.0):
    """Every pair of solids in the exported STEP: closest approach (screened on tessellations, measured exactly on the
    B-rep for every pair the screen cannot clear), overlap, whether each labelled body the script returned is still one
    solid, and whether each solid stands on the print plate (Z = 0) or on a solid that does. Council 2026-11-11
    (scan-to-make #734): chainmail links fused at 48 interfaces, a pawl grazing its wheel while a severed bar kept the
    solid count right, discs starting in mid-air, all with valid: true."""
    import time
    from build123d import Compound
    clearance, source, in_place = clearance_setting(request)
    started = time.monotonic()
    over = lambda: time.monotonic() - started > budget_s
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
    r3 = lambda v: [round(v[0], 3), round(v[1], 3), round(v[2], 3)]
    mid = lambda pa, pb: r3(((pa.X + pb.X) / 2, (pa.Y + pb.Y) / 2, (pa.Z + pb.Z) / 2))
    # The screen's error on a curved face is its chord sag, at most R a^2 / 8 per surface for angular deflection a; R is
    # bounded by half the pair's larger box diagonal. Every pair the screen reads within the clearance + 0.2 mm + that
    # sag is measured exactly on the B-rep.
    sag = lambda i: (boxes[i].diagonal / 2) * SCREEN_ANGLE ** 2 / 8
    window = lambda i, j: clearance + 0.2 + sag(i) + sag(j)
    def solid_manifold(s):
        v, f = s.tessellate(0.01, SCREEN_ANGLE)
        t = trimesh.Trimesh(np.array([[p.X, p.Y, p.Z] for p in v], dtype=float), np.array(f, dtype=np.int64), process=True)
        t.merge_vertices()
        return manifold(t)
    meshes = [None] * len(solids)
    rows, unmeasured, errors, exact_calls, screened_only = [], [], [], 0, 0
    near_pairs = []   # (i, j, gap) for every pair within its window: what rests on what
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            a, b = boxes[i], boxes[j]
            gap = math.sqrt(sum(max(0.0, lo2 - hi1, lo1 - hi2) ** 2 for lo1, hi1, lo2, hi2 in
                                ((a.min.X, a.max.X, b.min.X, b.max.X), (a.min.Y, a.max.Y, b.min.Y, b.max.Y), (a.min.Z, a.max.Z, b.min.Z, b.max.Z))))
            w = window(i, j)
            if gap >= w: continue
            if over():
                unmeasured.append((names[i], names[j], 'time budget'))
                continue
            try:
                for k in (i, j):
                    if meshes[k] is None: meshes[k] = solid_manifold(solids[k])
                if meshes[i].status() == mf.Error.NoError and meshes[j].status() == mf.Error.NoError:
                    d = meshes[i].min_gap(meshes[j], w)
                else:   # a tessellation that does not close: only the exact measurement can say
                    d = 0.0
                if d >= w: continue
                exact = exact_calls < EXACT_CAP and not over()
                if exact:
                    exact_calls += 1
                    d, pa, pb = solids[i].distance_to_with_closest_points(solids[j])
                    at = mid(pa, pb)
                    holds = lambda x, y: all(getattr(x.min, c) <= getattr(y.min, c) and getattr(y.max, c) <= getattr(x.max, c) for c in 'XYZ')
                    if d > 1e-6 and (holds(a, b) or holds(b, a)) and not over() and getattr(solids[i] & solids[j], 'volume', 0.0) > 1e-6:
                        d = 0.0   # one wholly inside the other: the surfaces never meet
                else:   # past the exact cap or the time budget: the screened gap, marked as such
                    screened_only += 1
                    at = r3([(max(getattr(a.min, c), getattr(b.min, c)) + min(getattr(a.max, c), getattr(b.max, c))) / 2 for c in 'XYZ'])
                rows.append({'a': names[i], 'b': names[j], 'gap_mm': round(d, 4), 'at': at, 'exact': exact})
                near_pairs.append((i, j, d))
            except Exception as e:   # one pair that cannot be measured does not cost the others
                errors.append(f'{names[i]} / {names[j]}: {type(e).__name__}: {e}'[:200])
                unmeasured.append((names[i], names[j], 'error'))
    fused = [r for r in rows if r['gap_mm'] <= 1e-6]
    under = [r for r in rows if 1e-6 < r['gap_mm'] < clearance - 1e-9]
    # a screened-only row read at or past the clearance is still within the screen's error of it: not cleared
    unsure = [r for r in rows if not r['exact'] and r['gap_mm'] >= clearance - 1e-9]
    closest = min(rows, key=lambda r: r['gap_mm']) if rows else None
    # The print plate is Z = 0 of the exported frame. A solid below it is cut off by the plate; one above it prints on
    # air unless it rests on a solid that reaches the plate (within its measured gap: print-in-place stacks).
    below = [{'solid': names[k], 'lowest_z_mm': round(boxes[k].min.Z, 3)} for k in range(len(solids)) if boxes[k].min.Z < -BED_TOLERANCE_MM]
    grounded = {k for k in range(len(solids)) if abs(boxes[k].min.Z) <= BED_TOLERANCE_MM}
    rests = {}
    changed = True
    while changed:
        changed = False
        for i, j, d in near_pairs:
            for up, low in ((i, j), (j, i)):
                if up not in grounded and low in grounded and boxes[low].min.Z < boxes[up].min.Z - BED_TOLERANCE_MM:
                    grounded.add(up); rests[up] = (low, d); changed = True
    above = []
    for k in range(len(solids)):
        z = boxes[k].min.Z
        if z <= BED_TOLERANCE_MM: continue
        row = {'solid': names[k], 'starts_mm_above_bed': round(z, 3), 'at': r3(((boxes[k].min.X + boxes[k].max.X) / 2, (boxes[k].min.Y + boxes[k].max.Y) / 2, z))}
        if k in rests: row.update(rests_on=names[rests[k][0]], gap_below_mm=round(rests[k][1], 4))
        above.append(row)
    floating = [r for r in above if 'rests_on' not in r]
    severed = [d for d in declared if d['solids'] != 1]
    def capped(items, say, kind):
        out = [say(x) for x in items[:8]]
        if len(items) > 8: out.append(f'... and {len(items) - 8} more {kind} (see bodies)')
        return out
    weld = 'they weld when printed' if in_place else 'a fit, not checked against print-in-place (P["print_in_place"] is False)'
    problems = (capped(fused, lambda r: f'{r["a"]} and {r["b"]} touch or overlap at {r["at"]}: they print as one piece', 'touching or overlapping pairs') +
                (capped(under, lambda r: f'{r["a"]} and {r["b"]} are {r["gap_mm"]} mm apart at {r["at"]}{"" if r["exact"] else " (screened, not measured exactly)"}, under the {clearance} mm print-in-place clearance: {weld}; if these bodies are shown assembled rather than printed in place, set P["print_in_place"] = False', 'pairs under the clearance') if in_place else []) +
                capped(unsure, lambda r: f'{r["a"]} and {r["b"]} screen at {r["gap_mm"]} mm, within the screen error of the {clearance} mm clearance, and were not measured exactly (exact cap or time budget)', 'unconfirmed pairs') +
                [f'body "{d["body"]}" is {d["solids"]} separate solids: something cuts it apart' if d['solids'] > 1 else f'body "{d["body"]}" has no solid' for d in severed] +
                capped(below, lambda r: f'{r["solid"]} reaches {r["lowest_z_mm"]} mm, below the print plate (Z = 0): the plate cuts it off', 'solids below the plate') +
                capped(floating, lambda r: f'{r["solid"]} starts {r["starts_mm_above_bed"]} mm above the print plate (Z = 0) with no solid under it that reaches the plate: its first layer is printed on air', 'floating solids'))
    if unmeasured:
        problems.append(f'{len(unmeasured)} near pair(s) were not measured ({", ".join(sorted({u[2] for u in unmeasured}))}); see bodies.pairs_not_measured')
    return {'solids': len(solids), 'clearance_mm': clearance, 'clearance_source': source, 'print_in_place': in_place,
            'declared_bodies': declared or None, 'pairs_measured': len(rows), 'exact_measurements': exact_calls, 'screened_only': screened_only,
            'pairs_not_measured': [{'a': u[0], 'b': u[1], 'why': u[2]} for u in unmeasured], 'errors': errors,
            'fused': fused, 'too_close': under, 'unconfirmed': unsure, 'closest': closest,
            'above_bed': above, 'below_bed': below, 'severed': severed, 'problems': problems,
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
        not_checked.append('gaps between separate bodies and contact with the print plate (mesh mode has no solids)')
        return {'checked': checked, 'not_checked': not_checked, 'problems': []}
    if 'error' in assembly:
        not_checked.append('gaps between separate bodies: the measurement failed (' + assembly['error'] + ')')
        return {'bodies': assembly, 'checked': checked, 'not_checked': not_checked, 'problems': ['bodies could not be measured: ' + assembly['error']]}
    checked.append('whether each solid stands on the print plate (Z = 0 of the exported frame) or rests on a solid that does, and whether any reaches below it (bodies; failures are in problems)')
    if assembly['solids'] > 1:
        pairs = f'the closest approach of each near pair of the {assembly["solids"]} solids'
        rule = (f'against a {assembly["clearance_mm"]} mm print-in-place clearance ({assembly["clearance_source"]})' if assembly['print_in_place']
                else 'for touching or overlap only: the script says its bodies are shown assembled (P["print_in_place"] is False)')
        if assembly['pairs_not_measured'] or assembly['unconfirmed']:
            not_checked.append(f'{pairs} {rule}: {len(assembly["pairs_not_measured"])} pair(s) were not measured and {len(assembly["unconfirmed"])} only screened (bodies)')
        else:
            checked.append(f'{pairs} {rule}, screened on tessellations and measured exactly where the screen could not clear them (bodies; failures are in problems)')
        if not assembly['print_in_place']:
            not_checked.append('print-in-place clearance: the bodies are declared as shown assembled')
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
