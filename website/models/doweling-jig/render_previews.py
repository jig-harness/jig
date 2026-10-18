"""Render the verified poses at delivery resolution with Freestyle."""
import sys
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from build import POSES, frame_camera

bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'doweling-jig.blend'))
scene = bpy.context.scene
parts = [obj for obj in scene.objects if obj.type == 'MESH']
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.cycles.samples = 64
for frame in POSES:
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    frame_camera(parts)
    scene.render.filepath = str(ROOT / f'frame-{frame:03d}.png')
    bpy.ops.render.render(write_still=True)
scene.frame_set(0)
bpy.context.view_layer.update()
frame_camera(parts)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'doweling-jig.blend'))
