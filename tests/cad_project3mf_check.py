"""project_3mf's inspection export (src/cad/project3mf.py) judged as the engine judges it. Run by cad-project-3mf.test.mjs
with one case name; prints one JSON line with "ok" and what the case measured."""
import json
import sys
import tempfile
import zipfile
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

import numpy as np
import trimesh

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # no __pycache__ beside the engine's sources
sys.path.insert(0, str(HERE.parent / "src" / "cad"))
from project3mf import Project3mf, export  # noqa: E402
from geometry import inspect, mesh as load_mesh  # noqa: E402

CORE = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
PROD = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'


def box(lo, hi):
    return trimesh.creation.box(bounds=[lo, hi])


def mesh_xml(object_id, m):
    vertices = ''.join(f'<vertex x="{x:g}" y="{y:g}" z="{z:g}"/>' for x, y, z in m.vertices)
    triangles = ''.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in m.faces)
    return f'<object id="{object_id}" type="model"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object>'


def write_3mf(folder, root, files, settings):
    path = Path(folder) / 'base.3mf'
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('3D/3dmodel.model', root)
        for name, text in files.items():
            archive.writestr(name, text)
        archive.writestr('Metadata/model_settings.config', settings)
        archive.writestr('Metadata/project_settings.config', json.dumps({'filament_colour': ['#111111', '#222222', '#333333']}))
    return path


def reused_ids(folder, count):
    """Object 10 made of `count` parts, each object id 1 in its own model file: part k is a 1 mm cube at x = 3k."""
    files = {f'3D/Objects/part_{k}.model': f'<?xml version="1.0"?><model {CORE}><resources>{mesh_xml(1, box([3 * k, 0, 0], [3 * k + 1, 1, 1]))}</resources><build/></model>'
             for k in range(count)}
    components = ''.join(f'<component p:path="/3D/Objects/part_{k}.model" objectid="1"/>' for k in range(count))
    root = (f'<?xml version="1.0"?><model {CORE} {PROD}><resources><object id="10" type="model"><components>{components}</components></object>'
            '</resources><build><item objectid="10"/></build></model>')
    settings = '<config><object id="10"><metadata key="name" value="Row"/><metadata key="extruder" value="1"/></object></config>'
    return write_3mf(folder, root, files, settings)


def run(project, folder, mode='mesh'):
    out = Path(folder) / 'design'
    with redirect_stdout(StringIO()):
        export(project, out, mode)
    return out


def judged(out, mode='mesh'):
    with redirect_stdout(StringIO()):
        result = inspect({'output': str(out.parent), 'name': out.name, 'mode': mode})
    return {'valid': result['valid'], 'checks': {k: v for k, v in result['checks'].items() if v is not None}}


def cubes_at(out):
    """The x position of each 1 mm-or-larger body in the combined inspection STL, by its min corner."""
    parts = load_mesh(str(out) + '.stl').split(only_watertight=False)
    return sorted([round(float(p.bounds[0][0]), 3), round(float(p.extents[0]), 3)] for p in parts)


def case_reused_ids_two(folder):
    """Replacing the part in part_1.model leaves part_0.model's part 1 as it was in the inspection STL."""
    project = Project3mf('kit', reused_ids(folder, 2))
    second = next(p for p in project.objects[0].parts if p.path == '/3D/Objects/part_1.model')
    project.replace_part(second, box([3, 0, 0], [5, 2, 2]))
    found = cubes_at(run(project, folder))
    return {'ok': found == [[0.0, 1.0], [3.0, 2.0]], 'bodies': found}


def case_reused_ids_three(folder):
    """Three files reuse object id 1; replacing the middle one's part changes only that part's inspection geometry."""
    project = Project3mf('kit', reused_ids(folder, 3))
    middle = next(p for p in project.objects[0].parts if p.path == '/3D/Objects/part_1.model')
    project.replace_part(middle, box([3, 0, 0], [5, 2, 2]))
    found = cubes_at(run(project, folder))
    return {'ok': found == [[0.0, 1.0], [3.0, 2.0], [6.0, 1.0]], 'bodies': found}


def case_touching_new(folder):
    """A new mesh project whose object is two colour parts stacked on the same footprint is one valid body."""
    project = Project3mf(None, None)
    project.add_part(box([0, 0, 0], [10, 10, 3]), name='Base', filament=1, object='Tag')
    project.add_part(box([0, 0, 3], [10, 10, 4]), name='Top', filament=2, object='Tag')
    result = judged(run(project, folder))
    return {'ok': result['valid'], **result}


def case_touching_edit(folder):
    """An edit adding a colour part that sits on a base part's top face, across its whole footprint, stays valid; so
    does a three-part tower whose object the build places twice."""
    root = (f'<?xml version="1.0"?><model {CORE}><resources>{mesh_xml(1, box([0, 0, 0], [10, 10, 3]))}'
            '<object id="2" type="model"><components><component objectid="1"/></components></object></resources>'
            '<build><item objectid="2"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></build></model>')
    settings = '<config><object id="2"><metadata key="name" value="Tag"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="Base"/></part></object></config>'
    project = Project3mf('kit', write_3mf(folder, root, {}, settings))
    project.add_part(box([0, 0, 3], [10, 10, 4]), name='Top', filament=2, object='Tag')
    project.add_part(box([2, 2, 4], [8, 8, 6]), name='Cap', filament=3, object='Tag')
    result = judged(run(project, folder))
    return {'ok': result['valid'], **result}


def case_defect_still_fails(folder):
    """A colour part with a missing face, touching a sound one, still fails the checks: fusing never hides a hole."""
    open_box = box([0, 0, 3], [10, 10, 4])
    open_box = trimesh.Trimesh(open_box.vertices, open_box.faces[:-1], process=False)
    project = Project3mf(None, None)
    project.add_part(box([0, 0, 0], [10, 10, 3]), name='Base', filament=1, object='Tag')
    project.add_part(open_box, name='Top', filament=2, object='Tag')
    result = judged(run(project, folder))
    return {'ok': result['valid'] is False and result['checks']['watertight'] is False, **result}


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as tmp:
        print(json.dumps(globals()['case_' + sys.argv[1]](tmp)))
