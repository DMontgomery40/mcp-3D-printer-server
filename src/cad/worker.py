"""Trusted CAD entry points. User code runs only in build, inside the OS sandbox.
Inspection is a fresh process: user stdout, globals and check claims are never receipts.
"""
import ast
import errno
import json
import math
import os
import resource
import sys
from pathlib import Path


def parameters(source, overrides):
    tree = ast.parse(source)
    declarations = [n for n in tree.body if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'P' for t in n.targets)]
    if len(declarations) != 1:
        raise ValueError('Declare exactly one top-level P = {...} dictionary of literal named parameters.')
    node = declarations[0]
    defaults = ast.literal_eval(node.value)
    if not isinstance(defaults, dict) or not all(isinstance(k, str) and k and len(k) <= 80 for k in defaults):
        raise ValueError('P must be a literal dictionary with named string keys.')
    if not isinstance(overrides, dict) or set(overrides) - set(defaults):
        raise ValueError('Unknown parameter override; only names declared in P may change.')
    merged = {**defaults, **overrides}
    encoded = json.dumps(merged, allow_nan=False)
    if len(encoded) > 65536:
        raise ValueError('Parameter values exceed 64 KiB.')
    # Avoid surprising scalar/container type changes while allowing integer -> float dimensions.
    for key, value in overrides.items():
        original = defaults[key]
        numeric = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
        if not (numeric(original) and numeric(value)) and type(original) is not type(value):
            raise ValueError('Parameter type changed: ' + key)
    return tree, node, merged


def scan_loader(inputs):
    """Explicit coordinate preparation only; never infer units or scale to a requested fit."""
    declared = dict(inputs)
    def load_scan(name, *, source_units, up_axis, ground=True):
        import numpy as np
        import trimesh
        if name not in declared: raise ValueError('load_scan requires a declared input name.')
        if source_units not in ('m', 'mm'): raise ValueError('source_units must explicitly be m or mm.')
        axes = {'x': [1,0,0], '-x': [-1,0,0], 'y': [0,1,0], '-y': [0,-1,0], 'z': [0,0,1], '-z': [0,0,-1]}
        if up_axis not in axes: raise ValueError('up_axis must be x, -x, y, -y, z or -z: the object usage-up direction in the source frame.')
        if not isinstance(ground, bool): raise ValueError('ground must be a boolean.')
        m = trimesh.load(declared[name], force='mesh', process=False)
        if not isinstance(m, trimesh.Trimesh) or not len(m.vertices) or not np.isfinite(m.vertices).all():
            raise ValueError('Scan must contain a finite triangle mesh.')
        factor = 1000.0 if source_units == 'm' else 1.0
        # Smallest rotation; aligning an axis must not add an arbitrary yaw.
        direction = np.asarray(axes[up_axis], dtype=float)
        rotation_axis = np.cross(direction, [0,0,1])
        angle = float(np.arccos(np.clip(direction[2], -1, 1)))
        matrix = (np.eye(4) if angle == 0 else
                  trimesh.transformations.rotation_matrix(angle, rotation_axis if np.linalg.norm(rotation_axis) else [1,0,0]))
        m.apply_scale(factor)
        m.apply_transform(matrix)
        lift = -float(m.bounds[0,2]) if ground else 0.0
        m.apply_translation([0,0,lift])
        m.merge_vertices()
        m.units = 'mm'
        m.metadata['cad_scan_frame'] = {'source_units':source_units,'units':'mm','source_up':up_axis,'up_axis':'z',
          'unit_factor':factor,'rotation':matrix.tolist(),'translation_z_mm':lift,'scale_to_fit':False}
        return m
    return load_scan


def limits():
    caps = [(resource.RLIMIT_FSIZE, 128 * 1024**2), (resource.RLIMIT_CPU, 900),
            (resource.RLIMIT_NOFILE, 128)]
    if sys.platform != 'darwin': caps.append((resource.RLIMIT_AS, 8 * 1024**3))
    for kind, requested in caps:
        _, hard = resource.getrlimit(kind)
        limit = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
        resource.setrlimit(kind, (limit, limit))


def main():
    mode = sys.argv[1]
    if mode == 'imports':
        import build123d
        import trimesh
        import manifold3d
        import numpy, scipy, skimage, shapely
        from PIL import Image
        print(json.dumps({'build123d': build123d.__version__}))
        return
    request = json.loads(Path(sys.argv[2]).read_text())
    if mode == 'parameters':
        _, _, merged = parameters(Path(request['script']).read_text(), json.loads(Path(request['parameters']).read_text()))
        print(json.dumps(merged, allow_nan=False))
        return
    limits()
    # -I omits both cwd and script directory; import only our package-owned helper.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    if mode == 'build':
        import build123d as cad
        source = Path(request['script']).read_text()
        tree, declaration, merged = parameters(source, json.loads(Path(request['parameters']).read_text()))
        declaration.value = ast.Name(id='__cad_parameters__', ctx=ast.Load())
        ast.fix_missing_locations(tree)
        from scan_touchup import scan_touchup_factory
        from project3mf import Project3mf, export as export_project, project_factory
        namespace = {'project_3mf': project_factory(request.get('inputs', {})), '__name__': 'cad_design', '__file__': request['script'], '__cad_parameters__': merged, 'INPUTS': request.get('inputs', {}), 'load_scan': scan_loader(request.get('inputs', {})),
                     'scan_touchup': scan_touchup_factory(request.get('inputs', {}))}
        exec(compile(tree, request['script'], 'exec'), namespace)
        shape = namespace['build']()
        out = Path(request['output']) / request['name']
        if isinstance(shape, Project3mf):
            # A 3MF project: parts and a manifest for the MCP to write the 3MF from, plus the usual combined exports.
            export_project(shape, out, request.get('mode', 'solid'))
        elif request.get('mode', 'solid') == 'mesh':
            import trimesh
            if not isinstance(shape, trimesh.Trimesh):
                raise ValueError('Mesh-mode build() must return a trimesh.Trimesh.')
            shape.export(str(out) + '.stl')
        else:
            if not isinstance(shape, cad.Shape) or not shape.is_valid or not shape.solids():
                raise ValueError('build() must return a valid build123d Shape containing solids.')
            cad.export_stl(shape, str(out) + '.stl', tolerance=0.01, angular_tolerance=0.1)
            cad.export_step(shape, str(out) + '.step')
            # The design as it is used: the part with what it holds (held:<name>) and what it meets (world:<name>),
            # Z up. Exported for the inspection process, which computes its loads; the script never reports them.
            # A use() that fails costs the run its readiness, never the export build() already made.
            if callable(namespace.get('use')):
                try:
                    used = namespace['use']()
                    if not isinstance(used, cad.Shape) or not used.solids():
                        raise ValueError('use() must return a build123d Shape: a Compound of the part with labelled held:<name> and world:<name> solids.')
                    cad.export_step(used, str(out) + '.use.step')
                except Exception as e:
                    Path(str(out) + '.use.error').write_text(f'{type(e).__name__}: {e}'[:300])
    elif mode == 'inspect':
        from geometry import inspect
        print(json.dumps(inspect(request), allow_nan=False))
    elif mode == 'fit':
        from geometry import fit
        print(json.dumps(fit(request), allow_nan=False))
    elif mode == 'smoke':
        import socket
        import build123d as cad
        from geometry import inspect
        request['name'] = 'smoke'
        out = Path(request['output'])
        shape = cad.Box(10, 20, 30)
        cad.export_stl(shape, str(out / 'smoke.stl'))
        cad.export_step(shape, str(out / 'smoke.step'))
        result = inspect(request)
        # Prove this confinement actually rejects out-of-workspace writes and personal reads.
        for target, operation in [(out.parent / 'cad-forbidden-write', 'write'),
                                  (Path(request['home']) / '.ssh', 'read')]:
            try:
                if operation == 'write': target.write_text('forbidden')
                else: os.listdir(target)
            except (PermissionError, FileNotFoundError):
                pass
            except OSError as e:
                # A read-only sandbox root refuses the write with EROFS: that is a rejection too.
                if e.errno != errno.EROFS: raise
            else:
                raise RuntimeError('CAD confinement did not reject ' + operation)
        sock = socket.socket()
        sock.settimeout(1)
        try:
            sock.connect(('192.0.2.1', 443))
        except OSError:
            pass
        else:
            raise RuntimeError('CAD confinement did not reject network access')
        finally:
            sock.close()
        print(json.dumps({'build123d': cad.__version__, **result['checks'], 'solid_count': result['solid_count']}))
    else:
        raise ValueError('Unknown CAD operation')


if __name__ == '__main__':
    main()
