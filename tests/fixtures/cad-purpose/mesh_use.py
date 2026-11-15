"""Mesh mode: no purpose is evaluated and use() is never called (a call would leave <name>.use.error or .use.step)."""
import trimesh
P = {}
PURPOSE = {"for": "a hook to hang my keys", "modelled_on": "a key hook", "holds": [{"body": "keys", "mass_g": 80}]}
def build():
    return trimesh.creation.box((10, 10, 10))
def use():
    raise RuntimeError('use() must not run in mesh mode')
