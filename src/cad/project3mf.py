"""3MF project output for cad_run: project_3mf() inside build().

A design script returns a project_3mf() instead of a shape when the result is a multi-part, multi-colour 3MF:
either a new project (parts with names, filaments and plates) or an edit of a declared input 3MF (a designer's
project), which keeps everything it does not change: print settings, painting, plates and other parts.

This module runs inside the sandbox. It reads the input 3MF, tessellates the script's geometry and writes STL
parts plus a manifest into the job folder; the trusted MCP process writes the 3MF itself and checks it.
"""
import json
import math
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

CORE = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'
PRODUCTION = '{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}'
ROOT_MODEL = '3D/3dmodel.model'
MAX_PARTS = 64
MAX_FILAMENT = 64
MAX_PLATES = 64
SKIPPED_SUBTYPES = ('negative_part', 'modifier_part', 'support_blocker', 'support_enforcer')


def _matrix(text):
    """A 3MF transform (12 numbers, row vectors) as a 4x4 column-vector matrix."""
    import numpy as np
    m = np.eye(4)
    if not text:
        return m
    values = [float(v) for v in text.split()]
    if len(values) != 12 or not all(math.isfinite(v) for v in values):
        raise ValueError('3MF transform must have 12 finite numbers.')
    m[:3, :3] = np.array(values[:9]).reshape(3, 3).T
    m[:3, 3] = values[9:]
    return m


def _metadata(element):
    return {m.get('key'): m.get('value', '') for m in element.findall('metadata') if m.get('key')}


def _int(value):
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return 0
    return number


class Part:
    """A model part of a 3MF object: its mesh in the object's frame (component transform applied)."""

    def __init__(self, object_id, part_id, path, name, filament, mesh, painted, local):
        self.object_id = object_id
        self.id = part_id
        self.path = path
        self.name = name
        self.filament = filament
        self.mesh = mesh
        self.painted = painted
        self._local = local  # component transform: mesh coordinates -> object frame
        self.plain = False  # the object is this one mesh, without parts (a plain 3MF): it cannot be edited

    def __repr__(self):
        return f'Part(id={self.id}, name={self.name!r}, filament={self.filament}, painted={self.painted})'


class Object:
    """A root object of the 3MF (what a build item places) with its parts."""

    def __init__(self, object_id, name, plate, parts, placements):
        self.id = object_id
        self.name = name
        self.plate = plate
        self.parts = parts
        self.placements = placements  # build-item transforms: object frame -> plate (build) frame

    def part(self, name_or_id):
        for part in self.parts:
            if str(part.id) == str(name_or_id) or part.name == name_or_id:
                return part
        raise ValueError(f'Object {self.name!r} has no part {name_or_id!r}.')

    def __repr__(self):
        return f'Object(id={self.id}, name={self.name!r}, plate={self.plate}, parts={self.parts!r})'


def _read(path):
    """The input 3MF's objects with their parts as trimesh meshes in each object's frame."""
    import numpy as np
    import trimesh
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        if ROOT_MODEL not in names:
            raise ValueError('The input 3MF has no 3D/3dmodel.model.')
        if any(re.fullmatch(r'Metadata/plate_\d+\.gcode', n) for n in names):
            raise ValueError('The input 3MF holds G-code: edit the project file, not a sliced .gcode.3mf.')
        # The input is a bounded snapshot (64 MiB): its model parts and settings are read once, here.
        raw = {n: archive.read(n) for n in names if n.endswith('.model') or n in ('Metadata/model_settings.config', 'Metadata/project_settings.config')}
    models = {}

    def model(name):
        name = name.lstrip('/')
        if name not in models:
            if name not in raw:
                raise ValueError(f'The input 3MF names a missing model part {name}.')
            models[name] = ET.fromstring(raw[name])
        return models[name]

    settings = ET.fromstring(raw['Metadata/model_settings.config']) if 'Metadata/model_settings.config' in raw else ET.Element('config')
    root = model(ROOT_MODEL)
    resources = {o.get('id'): o for o in root.iter(CORE + 'object')}
    config = {o.get('id'): o for o in settings.findall('object')}
    plate_of = {}
    for plate in settings.findall('plate'):
        number = _int(_metadata(plate).get('plater_id'))
        for instance in plate.findall('model_instance'):
            plate_of.setdefault(_metadata(instance).get('object_id'), number)
    placements = {}
    for item in root.iter(CORE + 'item'):
        placements.setdefault(item.get('objectid'), []).append(_matrix(item.get('transform')))

    def mesh_of(element):
        mesh = element.find(CORE + 'mesh')
        if mesh is None:
            return None, False
        vertices = np.array([[float(v.get(a)) for a in 'xyz'] for v in mesh.iter(CORE + 'vertex')], dtype=float).reshape(-1, 3)
        triangles = list(mesh.iter(CORE + 'triangle'))
        faces = np.array([[int(t.get(a)) for a in ('v1', 'v2', 'v3')] for t in triangles], dtype=np.int64).reshape(-1, 3)
        painted = any(t.get('paint_color') for t in triangles)
        return trimesh.Trimesh(vertices, faces, process=False), painted

    objects = []
    for object_id, items in placements.items():
        element = resources.get(object_id)
        if element is None:
            continue
        own = config.get(object_id)
        meta = _metadata(own) if own is not None else {}
        object_filament = _int(meta.get('extruder')) or 1
        part_config = {p.get('id'): p for p in own.findall('part')} if own is not None else {}
        parts = []
        components = element.find(CORE + 'components')
        if components is not None:
            for component in components.findall(CORE + 'component'):
                path = (component.get(PRODUCTION + 'path') or ROOT_MODEL).lstrip('/')
                part_id = component.get('objectid')
                part = part_config.get(part_id)
                part_meta = _metadata(part) if part is not None else {}
                if part is not None and part.get('subtype') == 'negative_part':
                    raise ValueError('CAD inspection of a 3MF project with negative volumes is not supported; '
                                     'the inspection mesh cannot yet apply their subtraction. Use a project with the cut baked into its mesh.')
                if part is not None and part.get('subtype', 'normal_part') in SKIPPED_SUBTYPES:
                    continue
                target = next((o for o in model(path).iter(CORE + 'object') if o.get('id') == part_id), None)
                if target is None:
                    raise ValueError(f'Component {part_id} of object {object_id} is missing from {path}.')
                mesh, painted = mesh_of(target)
                if mesh is None:
                    raise ValueError('CAD inspection of nested or empty 3MF components is not supported; '
                                     'use a project whose object components directly contain meshes.')
                local = _matrix(component.get('transform'))
                mesh.apply_transform(local)
                parts.append(Part(int(object_id), int(part_id), '/' + path, part_meta.get('name') or meta.get('name', ''),
                                  _int(part_meta.get('extruder')) or object_filament, mesh, painted, local))
        else:
            mesh, painted = mesh_of(element)
            if mesh is not None:
                part = Part(int(object_id), int(object_id), '/' + ROOT_MODEL, meta.get('name', ''), object_filament, mesh, painted, np.eye(4))
                part.plain = True
                parts.append(part)
        objects.append(Object(int(object_id), meta.get('name', ''), plate_of.get(object_id, 1), parts, items))
    if not objects:
        raise ValueError('The input 3MF has no object with a mesh.')
    # The filaments the project declares: a part can only print in one of them.
    declared = 0
    try:
        project = json.loads(raw.get('Metadata/project_settings.config', b'{}'))
        declared = max(len(project.get(key) or []) for key in ('filament_colour', 'filament_type', 'filament_ids'))
    except (ValueError, AttributeError, TypeError):
        declared = 0
    return objects, min(declared, MAX_FILAMENT)


def _geometry(value, label):
    """A build123d Shape or a trimesh.Trimesh, as given."""
    import trimesh
    import build123d as cad
    if isinstance(value, trimesh.Trimesh):
        if not len(value.faces):
            raise ValueError(label + ' is an empty mesh.')
        return value
    if isinstance(value, cad.Shape):
        if not value.is_valid or not value.solids():
            raise ValueError(label + ' must be a valid build123d Shape containing solids.')
        return value
    raise ValueError(label + ' must be a build123d Shape or a trimesh.Trimesh.')


def _filament(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_FILAMENT:
        raise ValueError(f'{label} must be an integer filament from 1 to {MAX_FILAMENT}.')
    return value


def _name(value, label):
    if not isinstance(value, str) or not value.strip() or '\0' in value or len(value) > 200:
        raise ValueError(label + ' must be a non-empty name of at most 200 characters.')
    return value.strip()


class Project3mf:
    """What build() returns for a 3MF project. Made by project_3mf(base=None)."""

    def __init__(self, base, base_path):
        self.base = base
        self.objects, self.filaments = _read(base_path) if base_path else ([], 0)
        self._new = []      # new project: {object, plate, name, filament, geometry}
        self._edits = []    # edit: operations on the base

    def object(self, name_or_id):
        """A base object by its root object id, or by its name when only one object has it."""
        for obj in self.objects:
            if str(obj.id) == str(name_or_id):
                return obj
        named = [obj for obj in self.objects if obj.name == name_or_id]
        if len(named) > 1:
            raise ValueError(f'{len(named)} objects are named {name_or_id!r} (ids ' + ', '.join(str(o.id) for o in named)
                             + '): pick one by id, or edit each copy.')
        if named:
            return named[0]
        raise ValueError(f'The input 3MF has no object {name_or_id!r}; objects: ' + ', '.join(repr(o.name) for o in self.objects))

    def _declared(self, filament, label):
        filament = _filament(filament, label)
        if self.base and self.filaments and filament > self.filaments:
            raise ValueError(f'{label} {filament} is not one of the {self.filaments} filaments the input 3MF declares.')
        return filament

    def _count(self):
        if len(self._new) + sum(1 for e in self._edits if 'geometry' in e) >= MAX_PARTS:
            raise ValueError(f'A project takes at most {MAX_PARTS} new or replaced parts.')

    def add_part(self, geometry, *, name, filament=None, object=None, plate=1):
        """Add a part. Editing a 3MF: into the base object `object` (name or id), in that object's frame.
        A new project: into the object named `object` (default: one object per part's name) on `plate`."""
        self._count()
        name = _name(name, 'name')
        geometry = _geometry(geometry, f'Part {name!r}')
        if self.base:
            if object is None:
                raise ValueError('Editing a 3MF, add_part needs object=: the base object (name or id) the part joins.')
            target = self.object(object)
            if any(part.plain for part in target.parts):
                raise ValueError(f'Object {target.name!r} is one mesh without parts (a plain 3MF): only a Bambu Studio or OrcaSlicer project\'s objects take new parts.')
            if plate != 1:
                raise ValueError('Editing a 3MF, a new part sits on its object\'s plate; plate cannot be set.')
            self._edits.append({'op': 'add_part', 'object_id': target.id, 'name': name,
                                'filament': self._declared(filament if filament is not None else (target.parts[0].filament if target.parts else 1), 'filament'),
                                'geometry': geometry})
        else:
            if isinstance(plate, bool) or not isinstance(plate, int) or not 1 <= plate <= MAX_PLATES:
                raise ValueError(f'plate must be an integer from 1 to {MAX_PLATES}.')
            self._new.append({'object': _name(object, 'object') if object is not None else name, 'plate': plate, 'name': name,
                              'filament': _filament(filament if filament is not None else len(self._new) + 1, 'filament'),
                              'geometry': geometry})
        return self

    def _base_part(self, part):
        if not self.base:
            raise ValueError('Only an edited 3MF has parts to change; add_part builds a new project.')
        if not isinstance(part, Part):
            raise ValueError('Pass a part from project.objects[...].parts (or project.object(...).part(...)).')
        if part.plain:
            raise ValueError(f'Part {part.name!r} is a plain 3MF object\'s only mesh, with no part settings to change: edit a Bambu Studio or OrcaSlicer project.')
        return part

    def replace_part(self, part, geometry):
        """Replace a base part's mesh with new geometry in its object's frame. Its painting goes with the old mesh."""
        part = self._base_part(part)
        self._count()
        self._edits.append({'op': 'replace_part', 'object_id': part.object_id, 'part_id': part.id, 'path': part.path,
                            'geometry': _geometry(geometry, f'Replacement for {part.name!r}'), 'local': part._local})
        return self

    def set_part(self, part, *, name=None, filament=None):
        """Rename a base part or change its filament (1-based). Painting on it is kept."""
        part = self._base_part(part)
        edit = {'op': 'set_part', 'object_id': part.object_id, 'part_id': part.id}
        if name is not None:
            edit['name'] = _name(name, 'name')
        if filament is not None:
            edit['filament'] = self._declared(filament, 'filament')
        if len(edit) == 3:
            raise ValueError('set_part needs name= or filament=.')
        self._edits.append(edit)
        return self


def project_factory(inputs):
    declared = dict(inputs)

    def project_3mf(base=None):
        """A 3MF project for build() to return: new (base=None) or an edit of the declared input 3MF `base`."""
        if base is None:
            return Project3mf(None, None)
        if base not in declared or not str(declared[base]).lower().endswith('.3mf'):
            raise ValueError('project_3mf(base) needs the name of a declared .3mf input.')
        return Project3mf(base, declared[base])
    return project_3mf


def _fused(meshes):
    """An object's parts as one body for the checks, as the STEP path fuses them: colour parts that touch or overlap
    print as one piece, and their shared faces are not the object's surface. A part that is not a closed solid is kept
    as it is, beside the others, so the checks still see the defect."""
    import numpy as np
    import trimesh
    import manifold3d as mf
    if len(meshes) < 2:
        return meshes
    solids, open_parts = [], []
    for m in meshes:
        part = m.copy()
        part.merge_vertices()
        solid = mf.Manifold(mf.Mesh(np.asarray(part.vertices, dtype=np.float32), np.asarray(part.faces, dtype=np.uint32))) if part.is_volume else None
        if solid is None or solid.status() != mf.Error.NoError:
            open_parts.append(m)
        else:
            solids.append(solid)
    if len(solids) < 2:
        return meshes
    union = mf.Manifold.batch_boolean(solids, mf.OpType.Add)
    body = union.to_mesh()
    if union.status() != mf.Error.NoError or not len(body.tri_verts):
        return meshes
    return [trimesh.Trimesh(np.asarray(body.vert_properties, dtype=float)[:, :3], np.asarray(body.tri_verts, dtype=np.int64), process=False)] + open_parts


def export(project, out, mode):
    """Write the project's parts as STL, a manifest the MCP writes the 3MF from, and one combined STL (plus STEP for a
    new all-solid project) for the engine's usual checks and renders. The combined STL holds one fused body per object
    placement, as the STEP holds one fused body per object."""
    import numpy as np
    import trimesh
    import build123d as cad
    if not project._new and not project._edits:
        raise ValueError('The 3MF project is empty: add_part, replace_part or set_part first.')
    if project.base and mode == 'solid':
        raise ValueError('Editing a 3MF runs with mode: "mesh": the designer\'s parts are meshes, with no STEP.')
    parts_dir = Path(str(out) + '.parts')
    parts_dir.mkdir()
    counter = [0]

    def stl(geometry, transform=None):
        index = counter[0]
        counter[0] += 1
        target = parts_dir / f'{index}.stl'
        if isinstance(geometry, trimesh.Trimesh):
            mesh = geometry.copy()
        else:
            cad.export_stl(geometry, str(target), tolerance=0.01, angular_tolerance=0.1)
            mesh = trimesh.load(str(target), force='mesh')
        if transform is not None:
            mesh.apply_transform(transform)
        mesh.export(str(target))
        return index, mesh

    manifest = {'version': 1, 'base': project.base}
    combined = []
    if project.base:
        edits = []
        replaced = {}
        for edit in project._edits:
            entry = {k: v for k, v in edit.items() if k not in ('geometry', 'local')}
            if edit['op'] == 'add_part':
                entry['stl'], mesh = stl(edit['geometry'])
                replaced.setdefault((None, edit['object_id'], 'new'), []).append(mesh)
            elif edit['op'] == 'replace_part':
                # The replacement is drawn in the object's frame; the file keeps the part's component transform.
                entry['stl'], mesh = stl(edit['geometry'], np.linalg.inv(edit['local']))
                # A part is its (model file, object, part id): two model files may reuse an object id. The mesh is kept
                # in its file's coordinates: an object that places it twice shows it under each component transform.
                replaced[(edit['path'], edit['object_id'], edit['part_id'])] = mesh
            edits.append(entry)
        manifest['edits'] = edits
        # The whole project as the build places it, with the edits, for the checks and renders.
        for obj in project.objects:
            meshes = []
            for part in obj.parts:
                fresh = replaced.get((part.path, obj.id, part.id))
                meshes.append(part.mesh if fresh is None else fresh.copy().apply_transform(part._local))
            meshes += replaced.get((None, obj.id, 'new'), [])
            meshes = _fused(meshes)
            for placement in obj.placements:
                combined += [m.copy().apply_transform(placement) for m in meshes]
    else:
        objects, meshes = {}, {}
        for part in project._new:
            key = part['object']
            if key in objects and objects[key]['plate'] != part['plate']:
                raise ValueError(f'Object {key!r} has parts on two plates; one object sits on one plate.')
            index, mesh = stl(part['geometry'])
            objects.setdefault(key, {'name': key, 'plate': part['plate'], 'parts': []})['parts'].append(
                {'stl': index, 'name': part['name'], 'filament': part['filament']})
            meshes.setdefault(key, []).append(mesh)
        for key in objects:
            combined += _fused(meshes[key])
        manifest['objects'] = list(objects.values())
        shapes = [p['geometry'] for p in project._new]
        if mode == 'solid':
            if not all(isinstance(s, cad.Shape) for s in shapes):
                raise ValueError('A project with mesh parts runs with mode: "mesh".')
            # One body per object, its parts fused: the parts of a multi-colour object print as one piece, so the
            # engine's body checks measure objects against each other, not an inlay against its own tile.
            labelled = []
            for key in objects:
                members = [p['geometry'] for p in project._new if p['object'] == key]
                body = members[0].fuse(*members[1:]) if len(members) > 1 else members[0].moved(cad.Location())
                body.label = key
                labelled.append(body)
            cad.export_step(cad.Compound(children=labelled), str(out) + '.step')
    trimesh.util.concatenate(combined).export(str(out) + '.stl')
    Path(str(out) + '.project.json').write_text(json.dumps(manifest))
