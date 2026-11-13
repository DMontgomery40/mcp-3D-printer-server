"""What a design is for, compiled into requirements the engine evaluates on the design as it is used (scan-to-make #608).

The council of 2026-11-11 found that the engine verified only what the designer wrote down: nothing could say "faces
the driver" or "the mount carries the phone's moment", so a phone holder square to the cabin on a 30 mm strip passed.
Here the script states its purpose as a literal PURPOSE = {...} (read from the source, never run, never overridden by
parameters); a small product-class table adds the requirements its words imply; and use() returns the part as it is
used, with what it holds (held:<name>) and what it meets (world:<name>). The forces and moments at each mount are
computed from that geometry, never supplied. cad_run records final only when every requirement passes.
"""
import ast
import math
import re
from pathlib import Path

import numpy as np

KINDS = ('tape', 'rests', 'screw', 'clamp', 'hook', 'other')
G = 9.81
DENSITY = {'pla': 1.24, 'petg': 1.27, 'abs': 1.04, 'asa': 1.07, 'tpu': 1.21, 'pc': 1.20, 'pa': 1.14, 'nylon': 1.14}
# The product classes a purpose's words put it in, and what each class requires whatever the designer lists.
HOLDER = re.compile(r'\b(holders?|hooks?|hangers?|stands?|docks?|mounts?|racks?|shel(f|ves)|brackets?|cradles?|caddy|caddies|organi[sz]ers?|holsters?)\b', re.I)
VEHICLE = re.compile(r'\b(cars?|trucks?|vans?|dash|dashboard|vents?|windshield|windscreen|vehicles?|bikes?|bicycles?|handlebars?|scooters?|motorcycles?|strollers?|boats?)\b', re.I)
SCREEN = re.compile(r'\b(phones?|iphones?|smartphones?|tablets?|ipads?|screens?|displays?|monitors?|kindles?|e-?readers?)\b', re.I)
# 3M VHB static shear holds 1000 g on 0.5 in^2 for 10,000 min at 22 C and 500 g at 93 C (about 30 and 15 kPa); 3M
# publishes no sustained tension rating, so the same figure bounds sustained tension. 3M's VHB structural glazing
# guide designs short-term loads (wind) to 85 kPa (12 psi). Check: a 50 mm disc under a 230 g phone 60 mm out reads
# about 11 kPa sustained, and a 5 N press over its ball almost nothing, as the bought mounts that work would.
TAPE_SUSTAINED_KPA = {'vehicle': 15.0, 'indoor': 30.0}
TAPE_SHORT_KPA = 85.0
FRICTION = 0.4          # printed plastic, or its pads, resting on wood, laminate or painted metal
TOUCH_MM = 0.5          # a held object within this of the part sits on it
PATCH_MM = 0.2          # part surface within this of a world body is in contact with it


def read(script):
    """PURPOSE from the script's source: (dict, None), (None, None) when absent, (None, error) when malformed."""
    try:
        tree = ast.parse(Path(script).read_text())
    except (OSError, SyntaxError, ValueError) as e:
        return None, f'the script could not be read ({type(e).__name__})'
    found = [n for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'PURPOSE' for t in n.targets)]
    if not found:
        return None, None
    if len(found) > 1:
        return None, 'declare exactly one top-level PURPOSE'
    try:
        value = ast.literal_eval(found[0].value)
    except ValueError:
        return None, 'PURPOSE must be a literal dictionary (no names or calls)'
    return (value, None) if isinstance(value, dict) else (None, 'PURPOSE must be a dictionary')


def compile_purpose(p):
    """The requirements a purpose implies: [(name, problem or None)] plus the load settings to evaluate."""
    text = str(p.get('for') or '')
    classes = [c for c, rx in (('holder', HOLDER), ('vehicle', VEHICLE), ('screen', SCREEN)) if rx.search(text)]
    out, req = {'classes': classes}, []
    req.append(('for', None if text.strip() else 'PURPOSE["for"] is missing: say who uses it, where, doing what, in the person\'s words'))
    req.append(('modelled_on', None if str(p.get('modelled_on') or '').strip() else 'PURPOSE["modelled_on"] is missing: name the bought product the design follows'))
    holds = p.get('holds') or []
    mounts = p.get('mounts') or []
    holds = holds if isinstance(holds, list) else [holds]
    mounts = mounts if isinstance(mounts, list) else [mounts]
    bad = [h for h in holds if not (isinstance(h, dict) and isinstance(h.get('body'), str) and isinstance(h.get('mass_g'), (int, float)) and not isinstance(h.get('mass_g'), bool) and h['mass_g'] >= 0)]
    if bad:
        req.append(('holds', 'each PURPOSE["holds"] entry is {"body": name, "mass_g": grams}'))
    bad = [m for m in mounts if not (isinstance(m, dict) and isinstance(m.get('body'), str) and m.get('by') in KINDS)]
    if bad:
        req.append(('mounts', 'each PURPOSE["mounts"] entry is {"body": name, "by": one of ' + ', '.join(KINDS) + '}'))
    if 'holder' in classes and not holds:
        req.append(('holds', f'"{text[:60]}" holds something: list it in PURPOSE["holds"] with its mass and model it in use() as held:<name>'))
    if (holds or 'holder' in classes) and not mounts:
        req.append(('mounts', 'what carries the load into the world is not named: list PURPOSE["mounts"] (the surface and how: ' + ', '.join(KINDS) + ') and model it in use() as world:<name>'))
    user = p.get('user')
    good_point = isinstance(user, (list, tuple)) and len(user) == 3 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in user)
    faces = p.get('faces')
    if 'screen' in classes and holds and faces is None:
        faces = {'body': holds[0].get('body') if isinstance(holds[0], dict) else None}
    if faces is not None or p.get('reach_mm') is not None:
        if not good_point:
            req.append(('user', 'a screen held for a person must face them: give PURPOSE["user"], their eye point [x, y, z] mm in the use() frame'))
    jolt = p.get('jolt_g', 0)
    jolt = float(jolt) if isinstance(jolt, (int, float)) and not isinstance(jolt, bool) and jolt >= 0 else 0.0
    if 'vehicle' in classes:
        jolt = max(jolt, 1.5)
    press = p.get('press_n', 1.5 if holds else 0.0)   # a finger on a screen or on what it holds
    press = float(press) if isinstance(press, (int, float)) and not isinstance(press, bool) and press >= 0 else 1.5
    material = str(p.get('material') or 'PLA').lower()
    out.update(requirements=req, holds=[h for h in holds if isinstance(h, dict)], mounts=[m for m in mounts if isinstance(m, dict)],
               user=list(map(float, user)) if good_point else None, faces=faces if isinstance(faces, dict) else None,
               within_deg=float((faces or {}).get('within_deg', 25)) if isinstance(faces, dict) else 25.0,
               reach_mm=p.get('reach_mm'), jolt_g=jolt, press_n=press,
               density=DENSITY.get(material, DENSITY['pla']), material=material,
               environment='vehicle' if 'vehicle' in classes else 'indoor')
    return out


def _mesh(shape, tol=0.05):
    import trimesh
    v, f = shape.tessellate(tol, 0.2)
    m = trimesh.Trimesh(np.array([[q.X, q.Y, q.Z] for q in v], float), np.array(f, np.int64), process=True)
    m.merge_vertices()
    return m


def _patch(part, world):
    """Part triangles lying on a world body: area, centroid, outward normal (part into world) and plane moments."""
    import trimesh
    tri = part.triangles
    d = np.abs(trimesh.proximity.ProximityQuery(world).signed_distance(tri.reshape(-1, 3))).reshape(-1, 3)
    on = (d <= PATCH_MM).all(axis=1)
    if not on.any():
        return None
    t, n, a = tri[on], part.face_normals[on], part.area_faces[on]
    area = float(a.sum())
    c = (t.mean(axis=1) * a[:, None]).sum(axis=0) / area
    mean = (n * a[:, None]).sum(axis=0) / area
    return {'tri': t, 'area': area, 'centroid': c, 'normal': mean, 'flat': float(np.linalg.norm(mean))}


def _plane(patch):
    n = patch['normal'] / np.linalg.norm(patch['normal'])
    e1 = np.cross(n, [0, 0, 1.0]) if abs(n[2]) < 0.9 else np.cross(n, [1.0, 0, 0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(n, e1)                                  # e1 x e2 = n
    q = patch['tri'] - patch['centroid']
    x, y = q @ e1, q @ e2                                 # (T, 3) each
    x0, x1, x2, y0, y1, y2 = x[:, 0], x[:, 1], x[:, 2], y[:, 0], y[:, 1], y[:, 2]
    A = np.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2
    ixx = float((A / 6 * (x0 * x0 + x1 * x1 + x2 * x2 + x0 * x1 + x1 * x2 + x2 * x0)).sum())
    iyy = float((A / 6 * (y0 * y0 + y1 * y1 + y2 * y2 + y0 * y1 + y1 * y2 + y2 * y0)).sum())
    ixy = float((A / 12 * (2 * x0 * y0 + 2 * x1 * y1 + 2 * x2 * y2 + x0 * y1 + x1 * y0 + x0 * y2 + x2 * y0 + x1 * y2 + x2 * y1)).sum())
    return n, e1, e2, x.ravel(), y.ravel(), ixx, iyy, ixy


def _held_face(held, part_com):
    """The held object's exposed face: the normal of its broad face that points away from the part, and its centre."""
    m = _mesh(held, 0.2)
    vals, vecs = m.principal_inertia_components, m.principal_inertia_vectors
    n = np.asarray(vecs[int(np.argmax(vals))], float)    # a plate's largest moment is about its normal
    com = np.asarray(m.center_mass, float)
    if n @ (com - part_com) < 0:
        n = -n
    half = float(np.max((m.vertices - com) @ n))
    return n, com + n * half, com


def evaluate(use_step, compiled):
    """Each requirement's status on the use() assembly, the computed loads at the mounts, and what blocks ready."""
    from build123d import Compound, import_step, CenterOf
    results, loads, notes = [], [], []
    for name, problem in compiled['requirements']:
        results.append({'requirement': name, 'status': 'fail' if problem else 'pass', 'says': problem or 'stated'})
    needs = compiled['holds'] or compiled['mounts'] or compiled['user'] is not None
    if not use_step.exists():
        if needs:
            results.append({'requirement': 'use', 'status': 'not_modelled', 'says': 'define use(): the part as it is used (Z up, gravity -Z) with each held:<name> object and world:<name> surface it meets, so the loads can be computed'})
        return results, loads, notes
    shape = import_step(str(use_step))
    kids = list(shape.children) if isinstance(shape, Compound) else []
    role = lambda c: (c.label or '').split(':', 1)
    held = {role(c)[1]: c for c in kids if role(c)[0] == 'held' and len(role(c)) == 2}
    world = {role(c)[1]: c for c in kids if role(c)[0] == 'world' and len(role(c)) == 2}
    part = [s for c in kids if role(c)[0] not in ('held', 'world') for s in c.solids()] or ([] if kids else list(shape.solids()))
    if not part:
        results.append({'requirement': 'use', 'status': 'not_modelled', 'says': 'use() returned no part bodies besides held: and world: ones'})
        return results, loads, notes
    part_shape = Compound(children=part) if len(part) > 1 else part[0]
    part_mesh = _mesh(part_shape)
    vol = sum(s.volume for s in part)
    part_mass = vol * compiled['density'] / 1000.0                     # g
    part_com = np.array(list(part_shape.center(CenterOf.MASS)), float) if vol > 0 else part_mesh.center_mass
    masses = [('the part', part_mass, part_com)]
    held_faces = []
    for h in compiled['holds']:
        body = held.get(h['body'])
        if body is None:
            results.append({'requirement': f'holds {h["body"]}', 'status': 'not_modelled', 'says': f'use() has no held:{h["body"]} body: model the object at its real size where it sits'})
            continue
        gap = float(body.distance_to(part_shape))
        ok = gap <= TOUCH_MM
        results.append({'requirement': f'holds {h["body"]}', 'status': 'pass' if ok else 'fail',
                        'says': f'held:{h["body"]} sits on the part ({gap:.2f} mm)' if ok else f'held:{h["body"]} is {gap:.1f} mm from the part: nothing carries it'})
        n, face, com = _held_face(body, part_com)
        masses.append((h['body'], float(h['mass_g']), com))
        held_faces.append((h['body'], n, face))
    patches = []
    for mnt in compiled['mounts']:
        body = world.get(mnt['body'])
        if body is None:
            results.append({'requirement': f'mounts {mnt["body"]}', 'status': 'not_modelled', 'says': f'use() has no world:{mnt["body"]} body: model the surface it meets ({mnt["by"]}) where it really is'})
            continue
        p = _patch(part_mesh, _mesh(body, 0.1))
        if p is None:
            results.append({'requirement': f'mounts {mnt["body"]}', 'status': 'not_modelled', 'says': f'the part does not touch world:{mnt["body"]} in use(): no contact, so no load path'})
            continue
        results.append({'requirement': f'mounts {mnt["body"]}', 'status': 'pass', 'says': f'{p["area"]:.0f} mm^2 of the part touches world:{mnt["body"]} ({mnt["by"]})'})
        patches.append((mnt, p))
    # The faces requirement: the held object's exposed face turned toward the person's eye.
    if compiled['user'] is not None:
        eye = np.array(compiled['user'], float)
        want = (compiled['faces'] or {}).get('body')
        for name, n, face in held_faces:
            if compiled['faces'] is not None and want not in (None, name):
                continue
            to = eye - face
            dist = float(np.linalg.norm(to))
            if compiled['faces'] is not None:
                ang = math.degrees(math.acos(max(-1.0, min(1.0, float(n @ to) / max(dist, 1e-9)))))
                ok = ang <= compiled['within_deg']
                results.append({'requirement': f'faces user ({name})', 'status': 'pass' if ok else 'fail', 'angle_deg': round(ang, 1),
                                'says': f'{name}\'s exposed face is {ang:.0f} deg off the line to the user\'s eye (allowed {compiled["within_deg"]:.0f})'})
            if isinstance(compiled['reach_mm'], (int, float)):
                ok = dist <= compiled['reach_mm']
                results.append({'requirement': f'reach ({name})', 'status': 'pass' if ok else 'fail', 'distance_mm': round(dist),
                                'says': f'{name} is {dist:.0f} mm from the user (allowed {compiled["reach_mm"]})'})
    if not patches or not compiled['mounts']:
        return results, loads, notes
    # Loads: gravity on everything, jolts along each axis, and a hand pressing each held object's exposed face.
    cases = [('gravity', np.array([0, 0, -G]), None)]
    j = compiled['jolt_g']
    if j > 0:
        for k, axis in enumerate('XYZ'):
            for s in (1, -1):
                d = np.zeros(3); d[k] = s * j * G
                cases.append((f'gravity + {j:g} g along {"+" if s > 0 else "-"}{axis}', np.array([0, 0, -G]) + d, None))
    if compiled['press_n'] > 0:
        for name, n, face in held_faces:
            cases.append((f'gravity + {compiled["press_n"]:g} N pressing {name}', np.array([0, 0, -G]), (face, -n * compiled['press_n'])))
    tri = np.concatenate([p['tri'] for _, p in patches])
    area = sum(p['area'] for _, p in patches)
    group = {'tri': tri, 'area': area, 'centroid': sum(p['centroid'] * p['area'] for _, p in patches) / area,
             'normal': sum(p['normal'] * p['area'] for _, p in patches) / area}
    kinds = {m['by'] for m, _ in patches}
    flat = float(np.linalg.norm(group['normal'])) >= 0.9
    kind = next(iter(kinds)) if len(kinds) == 1 else 'mixed'
    c = group['centroid']
    plane = _plane(group) if flat else None
    for label, g, press in cases:
        F, M = np.zeros(3), np.zeros(3)
        for _, mass, com in masses:
            f = g * mass / 1000.0                                       # N
            F += f; M += np.cross(com - c, f) / 1000.0                  # N m
        if press is not None:
            F += press[1]; M += np.cross(press[0] - c, press[1]) / 1000.0
        R, MR = -F, -M * 1000.0                                         # the mount's reaction on the part (N, N mm)
        row = {'case': label, 'force_n': round(float(np.linalg.norm(F)), 2), 'moment_nm': round(float(np.linalg.norm(M)), 3)}
        if plane is not None:
            n, e1, e2, x, y, ixx, iyy, ixy = plane
            N = float(R @ n)                                            # + pulls the part onto the surface: the tape in tension
            shear = float(np.linalg.norm(R - N * n))
            if kind == 'tape':
                det = ixy * ixy - iyy * ixx
                a, b = ((np.linalg.solve([[ixy, iyy], [ixx, ixy]], [MR @ e1, -(MR @ e2)])) if abs(det) > 1e-9 else (0.0, 0.0))
                peak = (N / area + a * x + b * y).max() * 1000.0          # kPa
                twist = abs(float(MR @ n)) * float(np.sqrt(x * x + y * y).max()) / max(ixx + iyy, 1e-9) * 1000.0
                row.update(peak_tension_kpa=round(float(max(peak, 0.0)), 1), shear_kpa=round(shear / area * 1000.0 + twist, 1))
            elif kind == 'rests':
                press_in = -N                                           # the surface pushes back: positive when resting
                if press_in <= 1e-9:
                    row.update(lifts=True)
                else:
                    from shapely.geometry import MultiPoint, Point
                    xc, yc = -float(MR @ e2) / N, float(MR @ e1) / N
                    hull = MultiPoint(list(zip(x.tolist(), y.tolist()))).convex_hull
                    inside = hull.buffer(1e-6).contains(Point(xc, yc))
                    margin = hull.exterior.distance(Point(xc, yc)) if hasattr(hull, 'exterior') else 0.0
                    row.update(tips=not inside, tip_margin_mm=round(float(margin if inside else -margin), 1),
                               slides=bool(shear > FRICTION * press_in + 1e-9))
        loads.append(row)
    names = ', '.join(m['body'] for m, _ in patches)
    if kind == 'tape' and plane is not None:
        stress = lambda r: max(r['peak_tension_kpa'], r['shear_kpa'])
        sustained, short = loads[0], max(loads[1:], key=stress, default=None)
        for row, limit, word in ((sustained, TAPE_SUSTAINED_KPA[compiled['environment']], 'sustained'), (short, TAPE_SHORT_KPA, 'short-term')):
            if row is None:
                continue
            ok = stress(row) <= limit
            results.append({'requirement': f'tape on {names}, {word}', 'status': 'pass' if ok else 'fail',
                            'says': f'{row["case"]}: peak tension {row["peak_tension_kpa"]} kPa, shear {row["shear_kpa"]} kPa over {area:.0f} mm^2 (allowed {limit:g} kPa {word}; 3M VHB)'})
    elif kind == 'rests' and plane is not None:
        bad = [f'{row["case"]}: ' + ' and '.join(w for w, flag in (('lifts off', row.get('lifts')), ('tips over', row.get('tips')), ('slides', row.get('slides'))) if flag)
               for row in loads if row.get('lifts') or row.get('tips') or row.get('slides')]
        least = min((row.get('tip_margin_mm', 0) for row in loads), default=0)
        results.append({'requirement': f'rests on {names}', 'status': 'fail' if bad else 'pass',
                        'says': '; '.join(bad) if bad else f'stays put in every case, the load at least {least} mm inside its footprint'})
    else:
        notes.append(f'the strength of the {kind} interface on {names}: its loads are computed (purpose.loads), its capacity is not')
    return results, loads, notes


def inspect_purpose(request):
    """The purpose block of a solid result, or None for mesh mode and 3MF projects (their paths are unchanged)."""
    base = Path(request['output']) / request['name']
    if request.get('mode', 'solid') != 'solid' or Path(str(base) + '.project.json').exists():
        return None
    p, error = read(request['script'])
    if p is None:
        why = error or 'no PURPOSE: say what the part is for (PURPOSE = {"for": ..., "modelled_on": ...}) so its use can be checked'
        return {'declared': False, 'requirements': [{'requirement': 'purpose', 'status': 'not_modelled', 'says': why}],
                'loads': [], 'not_checked': [], 'blocked': [why], 'ready': False}
    compiled = compile_purpose(p)
    try:
        results, loads, notes = evaluate(Path(str(base) + '.use.step'), compiled)
    except Exception as e:   # a measurement that failed proves nothing: reported, and it blocks ready
        loads, notes = [], []
        results = [{'requirement': n, 'status': 'fail' if pr else 'pass', 'says': pr or 'stated'} for n, pr in compiled['requirements']]
        results.append({'requirement': 'use', 'status': 'not_modelled', 'says': f'the use() assembly could not be measured ({type(e).__name__}: {e})'[:300]})
    blocked = [f'{r["requirement"]}: {r["says"]}' for r in results if r['status'] != 'pass']
    return {'declared': True, 'for': str(p.get('for') or ''), 'modelled_on': str(p.get('modelled_on') or ''),
            'classes': compiled['classes'], 'user': compiled['user'], 'material': compiled['material'], 'jolt_g': compiled['jolt_g'], 'press_n': compiled['press_n'],
            'requirements': results, 'loads': loads, 'not_checked': notes, 'blocked': blocked, 'ready': not blocked}
