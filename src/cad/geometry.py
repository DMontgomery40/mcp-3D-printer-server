"""Independent geometry checks, six orthographic views, a perspective view and triangle-exact surface separation."""
from pathlib import Path
import json
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
    try:
        assembly = bodies(step, request) if step is not None else None
    except Exception as e:   # a failed measurement must not cost the person the export; it is reported, not passed
        assembly = {'error': f'{type(e).__name__}: {e}'[:300]}
    # What the part is for, evaluated on the design as it is used (purpose.py): ready, and why not.
    from purpose import inspect_purpose
    try:
        purpose = inspect_purpose(request, float(step.volume) if step is not None else None)
    except Exception as e:
        why = f'the purpose could not be evaluated: {type(e).__name__}: {e}'[:300]
        purpose = {'declared': None, 'requirements': [], 'loads': [], 'not_checked': [], 'blocked': [why], 'ready': False}
    renders = render(m, base.parent / (base.name + '.renders'))
    if purpose is not None and Path(str(base) + '.use.step').exists():
        try:
            renders['use'] = use_view(Path(str(base) + '.use.step'), base.parent / (base.name + '.renders'), purpose.get('user'))
        except Exception as e:
            purpose['not_checked'].append(f'the view of the design in use could not be drawn: {type(e).__name__}')
    found = evidence(assembly)
    if purpose is not None:
        found['checked'].append('what PURPOSE says it is for, compiled into requirements and evaluated on use(): the held objects, the mounts, the loads at each mount and whether it faces its user (purpose; anything not passing is in purpose.blocked)')
        found['not_checked'] += purpose['not_checked']
    return {'valid': all(v for v in checks.values() if v is not None), 'units': 'mm', 'bounds_mm': bounds,
            'size_mm': m.extents.tolist(), 'volume_mm3': float(m.volume) if m.is_volume else None,
            'step_volume_mm3': float(step.volume) if step is not None else None, 'solid_count': len(step.solids()) if step is not None else len(m.split(only_watertight=True)),
            'mesh_components': len(m.split(only_watertight=False)), 'checks': checks,
            **found, 'renders': renders,
            # ready needs sound geometry too; problems (body gaps) stay advisory, as they were
            **({'purpose': purpose, 'ready': purpose['ready'] and all(v for v in checks.values() if v is not None)} if purpose is not None else {})}


def use_view(step, folder, eye=None):
    """The design as it is used, held objects and the surfaces it meets included, seen from the user's eye when given."""
    user = eye is not None
    from build123d import Box, Compound, Pos, import_step
    from purpose import _mesh
    shape = import_step(str(step))
    kids = list(shape.children) if isinstance(shape, Compound) else []
    world = [c for c in kids if (c.label or '').startswith('world:')]
    if world and len(world) < len(kids):
        # Only the part of a wall, desk or dash near the design: a whole slab would fill the picture.
        rest = Compound(children=[c for c in kids if c not in world]).bounding_box()
        near = Pos(*rest.center()) * Box(rest.size.X + 50, rest.size.Y + 50, rest.size.Z + 50)
        clipped = [c & near for c in world]
        shape = Compound(children=[c for c in kids if c not in world] + [c for c in clipped if c.solids()])
    m = _mesh(shape, 0.1)
    az, el = 35.0, 26.0
    if eye is None and world and len(world) < len(kids):
        # No eye given: look from the part's side of the surface it meets, so a wall or armrest never hides it.
        towards = np.array(list(rest.center()), float) - np.array(list(Compound(children=world).bounding_box().center()), float)
        if np.linalg.norm(towards) > 1e-6:
            default = np.array([math.sin(math.radians(az)) * math.cos(math.radians(el)), -math.cos(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(el))])
            eye = m.bounds.mean(axis=0) + 1000 * (towards / np.linalg.norm(towards) + 0.7 * default)
    if eye is not None:
        d = np.asarray(eye, float) - m.bounds.mean(axis=0)
        az, el = math.degrees(math.atan2(d[0], -d[1])), max(-75.0, min(75.0, math.degrees(math.atan2(d[2], math.hypot(d[0], d[1])))))
    im = perspective(m, 1200, az, el)
    label = 'in use' + (', from the user\'s eye' if user else ', from the side it is used from' if eye is not None else ', from the front right and above')
    ImageDraw.Draw(im).text((24, 20), label, fill='black', font=ImageFont.load_default(size=28))
    file = folder / 'use.png'; im.resize((800, 800), Image.LANCZOS).save(file)
    return str(file)


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
                    screened = d
                    d, pa, pb = solids[i].distance_to_with_closest_points(solids[j])
                    if d <= 1e-6 and screened > 1e-3 and not over() and getattr(solids[i] & solids[j], 'volume', 0.0) <= 1e-6:
                        # The B-rep distance can call a shaft in its threaded hole "inside" the other solid and return 0
                        # where the tessellations are apart and the solids share no volume (a printed screw in its nut,
                        # desk_clamp_hook at opening 31): measure the surfaces, which have no inside.
                        d, pa, pb = Compound(solids[i].faces()).distance_to_with_closest_points(Compound(solids[j].faces()))
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
    # air unless it rests on a solid that reaches the plate: material directly under its first layer, within the pair's
    # window (print-in-place stacks).
    below = [{'solid': names[k], 'lowest_z_mm': round(boxes[k].min.Z, 3)} for k in range(len(solids)) if boxes[k].min.Z < -BED_TOLERANCE_MM]
    grounded = {k for k in range(len(solids)) if abs(boxes[k].min.Z) <= BED_TOLERANCE_MM}
    rests, support_unknown, supports = {}, set(), {}
    def held_up(up, low):
        # Support is material of low directly under up's first layer: the footprint of up's lowest 0.2 mm overlaps
        # the footprint of low within the pair's window below it. A neighbour beside the solid is not under it
        # (Codex review, 2026-11-11: a box 10 mm up, 0.4 mm beside a taller grounded box, read as resting on it).
        if (up, low) not in supports:
            z, w = boxes[up].min.Z, window(up, low)
            if meshes[up] is None or meshes[low] is None or meshes[up].status() != mf.Error.NoError or meshes[low].status() != mf.Error.NoError:
                supports[(up, low)] = None
            else:
                lo = [min(boxes[up].min.X, boxes[low].min.X) - 1, min(boxes[up].min.Y, boxes[low].min.Y) - 1]
                size = [max(boxes[up].max.X, boxes[low].max.X) + 1 - lo[0], max(boxes[up].max.Y, boxes[low].max.Y) + 1 - lo[1]]
                band = lambda m, z0, z1: (m ^ mf.Manifold.cube((size[0], size[1], z1 - z0)).translate((lo[0], lo[1], z0))).project()
                supports[(up, low)] = (band(meshes[up], z, z + 0.2) ^ band(meshes[low], z - w, z + BED_TOLERANCE_MM)).area() > 1e-3
        return supports[(up, low)]
    changed = True
    while changed:
        changed = False
        for i, j, d in near_pairs:
            for up, low in ((i, j), (j, i)):
                if up not in grounded and low in grounded and boxes[low].min.Z < boxes[up].min.Z - BED_TOLERANCE_MM:
                    try:
                        held = held_up(up, low)
                    except Exception as e:
                        held = None
                        errors.append(f'support of {names[up]} on {names[low]}: {type(e).__name__}: {e}'[:200])
                    if held is None: support_unknown.add(up)
                    elif held: grounded.add(up); rests[up] = (low, d); changed = True
    above = []
    for k in range(len(solids)):
        z = boxes[k].min.Z
        if z <= BED_TOLERANCE_MM: continue
        row = {'solid': names[k], 'starts_mm_above_bed': round(z, 3), 'at': r3(((boxes[k].min.X + boxes[k].max.X) / 2, (boxes[k].min.Y + boxes[k].max.Y) / 2, z))}
        if k in rests: row.update(rests_on=names[rests[k][0]], gap_below_mm=round(rests[k][1], 4))
        elif k in support_unknown: row['support_not_measured'] = True
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
                capped(floating, lambda r: f'{r["solid"]} starts {r["starts_mm_above_bed"]} mm above the print plate (Z = 0) and whether a solid under it reaches the plate could not be measured (a tessellation that does not close)' if r.get('support_not_measured') else f'{r["solid"]} starts {r["starts_mm_above_bed"]} mm above the print plate (Z = 0) with no solid under it that reaches the plate: its first layer is printed on air', 'floating solids'))
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
