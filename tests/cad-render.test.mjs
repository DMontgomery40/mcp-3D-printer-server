import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const python =
  process.env.CAD_RENDER_PYTHON ||
  (process.env.CAD_E2E_DATA_DIR &&
    path.join(process.env.CAD_E2E_DATA_DIR, "runtime", "bin", "python"));
const geometry = fileURLToPath(
  new URL("../src/cad/geometry.py", import.meta.url),
);

test(
  "renders reveal recessed windows and visible edges without a triangle wireframe, and the perspective view is depth-correct",
  {
    skip:
      !python && "set CAD_RENDER_PYTHON or CAD_E2E_DATA_DIR to a CAD runtime",
    timeout: 120000,
  },
  () => {
    const result = spawnSync(
      python,
      [
        "-I",
        "-c",
        String.raw`
import hashlib, json, runpy, tempfile
from pathlib import Path
import numpy as np
import trimesh
from PIL import Image

render = runpy.run_path(${JSON.stringify(geometry)})['render']
background = np.array([245, 245, 242])
views = ['front', 'back', 'left', 'right', 'top', 'bottom']

def box(size, centre=(0, 0, 0)):
    result = trimesh.creation.box(size)
    result.apply_translation(centre)
    return result

def front_pixel(x, z):
    return (int(round(400 - 17 * x)), int(round(400 - 17 * z)))

def sample(image, x, z):
    px, py = front_pixel(x, z)
    return np.array(image.getpixel((px, py)), dtype=float)

with tempfile.TemporaryDirectory(prefix='cad-render-') as temp:
    root = Path(temp)
    # An open cup with a U-window in its near wall. The window looks onto a
    # parallel interior wall: normal-only lighting makes the opening disappear.
    cup = trimesh.boolean.difference([
        box([40, 30, 40]), box([32, 22, 40], (0, 0, 4)),
        box([12, 10, 24], (0, 15, 12)),
    ], engine='manifold')
    paths = render(cup, root / 'cup')
    front = Image.open(paths['front'])
    near, recessed = sample(front, -12, 10), sample(front, 0, 10)
    contrast = float(np.linalg.norm(near - recessed))
    assert contrast >= 25, f'window rear wall must differ from front wall: {near}, {recessed}, contrast={contrast}'
    # The reveal is edge-on in this view, so it also needs a visible crease.
    px, py = front_pixel(-6, 10)
    edge = np.asarray(front)[py-2:py+3, px-2:px+3].mean(axis=2).min()
    assert edge < min(near.mean(), recessed.mean()) - 20, f'window crease missing: {edge}'

    assert set(paths) == set(views + ['perspective', 'contact'])
    for name in views + ['perspective']:
        assert Image.open(paths[name]).size == (800, 800)
    # The sheet: the perspective view large on the left, the six views in two columns beside it.
    sheet = Image.open(paths['contact'])
    assert sheet.size == (2668, 1602)
    for i, name in enumerate(views):
        x, y = 1600 + (i % 2) * 534, (i // 2) * 534
        tile = sheet.crop((x, y, x + 534, y + 534))
        assert tile.tobytes() == Image.open(paths[name]).resize((534, 534), Image.LANCZOS).tobytes()
    big = np.asarray(sheet.crop((0, 0, 1600, 1600)))
    teal = (big[:, :, 2] > big[:, :, 1]) & (big[:, :, 1] > big[:, :, 0])
    assert 0.15 < teal.mean() < 0.8, f'perspective view should fill the frame: {teal.mean()}'

    # Perspective uses a depth buffer: a thin post standing on a wide plate (two huge triangles per face)
    # must stay visible in front of the plate's far half, which depth-sorting by triangle would paint over it.
    perspective = runpy.run_path(${JSON.stringify(geometry)})['perspective']
    plate = box([120, 120, 2], (0, 0, 1))
    post = box([4, 4, 60], (0, 0, 32))
    def solid_columns(m):
        rgb = np.asarray(perspective(m, 800))
        mask = (rgb[:, :, 2] > rgb[:, :, 1]) & (rgb[:, :, 1] > rgb[:, :, 0])
        return mask
    both = solid_columns(trimesh.util.concatenate([plate, post]))
    rows = np.where(both.any(axis=1))[0]
    top_band = both[rows[0]:rows[0] + 40]
    assert 3 <= top_band.sum(axis=1).max() <= 60, 'the post should stand clear above the plate as a narrow column'
    widths = both[rows[0]:rows[0] + 300].sum(axis=1)
    assert (widths[:200] > 0).all(), 'the post is interrupted: something behind it was painted over it'
    again = render(cup, root / 'again')
    hashes = {}
    for name in paths:
        assert Path(paths[name]).read_bytes() == Path(again[name]).read_bytes(), name + ' changed between renders'
        hashes[name] = hashlib.sha256(Path(paths[name]).read_bytes()).hexdigest()

    # A genuine through-hole retains the background rather than filling it.
    tunnel = trimesh.boolean.difference([box([40, 4, 40]), box([12, 10, 16])], engine='manifold')
    hole = Image.open(render(tunnel, root / 'hole')['front'])
    assert np.array_equal(sample(hole, 0, 0), background)

    # A rear feature must not show through a nearer solid wall. Coplanar face
    # diagonals must not become strokes, even after subdividing a scan mesh.
    solid = box([40, 30, 40])
    rear = box([8, 2, 8], (0, -18, 0))
    covered = Image.open(render(trimesh.util.concatenate([solid, rear]), root / 'covered')['front'])
    pixels = np.asarray(covered)[230:570, 230:570]
    assert pixels.mean(axis=2).min() > 90, 'hidden rear edges or coplanar diagonals leaked through'
    refined = Image.open(render(solid.subdivide().subdivide(), root / 'refined')['front'])
    assert np.asarray(refined)[230:570, 230:570].mean(axis=2).min() > 90, 'scan tessellation became a wireframe'

    # Open scans have boundary edges even when there is no adjacent crease.
    plane = trimesh.Trimesh(vertices=[[-20, 0, -20], [-20, 0, 20], [20, 0, 20], [20, 0, -20]],
                            faces=[[0, 1, 2], [0, 2, 3]])
    open_scan = Image.open(render(plane, root / 'open')['front'])
    assert sample(open_scan, 20, 0).mean() < 70, 'open boundary is missing'
    assert sample(open_scan, 0, 0).mean() > 90, 'coplanar open-scan diagonal became an edge'

    # Retain the opposite-view handedness used by the six-view contract.
    asymmetric = trimesh.util.concatenate([box([10, 20, 30]), box([6, 6, 6], (4, 9, 14))])
    centres = {}
    for name, file in render(asymmetric, root / 'asym').items():
        if name in ('contact', 'perspective'): continue
        rgb = np.asarray(Image.open(file))
        ys, xs = np.where((rgb[:, :, 2] > rgb[:, :, 1]) & (rgb[:, :, 1] > rgb[:, :, 0]))
        assert len(xs) > 1000
        centres[name] = float(xs.mean())
    for a, b in [('front', 'back'), ('left', 'right'), ('top', 'bottom')]:
        assert abs(centres[a] + centres[b] - 799) < 2, centres
    assert centres['left'] > centres['right'] + 4, centres
    assert centres['bottom'] > centres['top'] + 4, centres
    print(json.dumps({'window_contrast': contrast, 'window_edge_luma': float(edge), 'sha256': hashes, 'centres': centres}))
`,
      ],
      { encoding: "utf8", timeout: 110000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    console.log(result.stdout.trim());
  },
);
