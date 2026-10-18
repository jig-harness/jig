"""Build the metre-scale, parameter-driven jig in Blender 4.5 LTS.

Usage: Blender --background --factory-startup --python build.py
Optional: -- --quick (800 x 450 inspection images), --no-render.
The shafts run under the board, the rails extend past both jaws, and the guide
block stands on support arms above the jaws, so no two solids overlap.
"""
import json
import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from uv_map import apply_uv
from primitives import (
    activate, apply_geometry_transform, material, box, cylinder, boolean,
    origin, parent_keep_world, helical_cutter, aim, triangle_counts,
)

MM = 0.001
P = json.loads((ROOT / 'parameters.json').read_text())

# The clip's poses, as frames: open, the jaws clamped, the side bushings
# seated, and the bit at the board on the last frame.
CLAMPED = round(P['last_frame'] * 0.55)
SEATED = round(P['last_frame'] * 0.8)
POSES = (0, CLAMPED, SEATED, P['last_frame'])
# Each phase needs frames of its own; the bake divides by their lengths.
assert 0 < CLAMPED < SEATED < P['last_frame'], ('last_frame too short for the clip\'s phases', POSES)


def m(key):
    return P[key] * MM


def build():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for data in (bpy.data.materials, bpy.data.actions, bpy.data.worlds):
        for item in list(data):
            data.remove(item)
    scene = bpy.context.scene
    scene.name = 'Doweling jig'
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = 'MILLIMETERS'
    scene.render.fps = P['fps']
    scene.frame_start = 0
    scene.frame_end = P['last_frame']
    scene['parameters_mm'] = json.dumps(P, sort_keys=True)
    scene['design_note'] = 'Underside shafts, extended rails, guide block raised on support arms: only mating contacts touch.'

    wood = material('Wood', (0.72, 0.51, 0.29), roughness=0.72)
    steel = material('Steel', (0.34, 0.37, 0.40), metallic=0.58, roughness=0.34)
    rubber = material('Rubber', (0.055, 0.06, 0.065), roughness=0.8)
    parts = []

    board = box('Board', (m('board_length'), m('board_width'), m('board_height')),
                (0, 0, m('board_height') / 2), wood)
    parts.append(board)

    half_board = m('board_width') / 2
    web_depth = m('jaw_web_depth')
    jaw_top = m('bridge_base_z')
    jaw_bottom = m('jaw_base_z')
    shaft_z = m('shaft_z')
    jaw_height = jaw_top - jaw_bottom
    jaws = []
    for name, side in [('JawNear', -1), ('JawFar', 1)]:
        y = side * (half_board + web_depth / 2)
        jaw = box(name, (m('jaw_length'), web_depth, jaw_height),
                  (0, y, (jaw_top + jaw_bottom) / 2), steel)
        foot_depth = web_depth + m('jaw_foot_extension')
        foot_y = y - side * m('jaw_foot_extension') / 2
        foot = box('Foot tool', (m('jaw_length'), foot_depth, m('jaw_foot_thickness')),
                   (0, foot_y, jaw_bottom + m('jaw_foot_thickness') / 2))
        boolean(jaw, foot, 'UNION')
        for x, diameter in [(-m('rod_x'), m('rod_diameter')),
                            (0, m('screw_diameter')),
                            (m('rod_x'), m('rod_diameter'))]:
            tool = cylinder('Bore tool', diameter + m('fit_clearance_diameter'),
                            foot_depth + m('boolean_overshoot'), (x, y, shaft_z), 'Y')
            boolean(jaw, tool)
        origin(jaw, (0, foot_y, jaw_bottom))
        jaw['base_origin'] = 'Centre of the complete L-foot footprint'
        jaw['closed_clamping_face_y_mm'] = side * P['board_width'] / 2
        jaws.append(jaw)
        parts.append(jaw)
    near, far = jaws

    for name, x in [('RodLeft', -m('rod_x')), ('RodRight', m('rod_x'))]:
        rod = cylinder(name, m('rod_diameter'), m('rod_length'), (x, 0, shaft_z), 'Y', steel)
        parts.append(rod)

    screw = cylinder('Screw', m('screw_diameter'), m('screw_length'),
                     (0, 0, shaft_z), 'Y', steel, sides=64)
    # Seven starts give a 5 mm axial pitch and a 35 mm lead: two revolutions
    # produce the specified 70 mm jaw stroke. The far half has opposite hand.
    lead = m('opening_per_jaw') / 2
    thread_half_length = m('screw_length') / 2 - m('thread_end_offset')
    for side in (-1, 1):
        for start in range(P['thread_starts']):
            cutter = helical_cutter(
                'Thread groove tool', m('screw_diameter') / 2 + m('thread_radial_offset'),
                thread_half_length, lead, m('thread_groove_radius'),
                center=(0, side * (m('screw_length') / 4 + m('thread_end_offset')), shaft_z),
                axis='Y', phase=math.tau * start / P['thread_starts'],
                handedness=1 if side == -1 else -1, steps_per_turn=56,
            )
            boolean(screw, cutter)
    screw['thread'] = 'Near: right hand; far: left hand; 7 starts; 5 mm pitch; 35 mm lead'
    parts.append(screw)

    hub_y = -m('screw_length') / 2 - m('handle_hub_length') / 2
    handle = cylinder('Handle', m('handle_hub_diameter'), m('handle_hub_length'), (0, hub_y, shaft_z), 'Y', steel)
    bar = cylinder('T-bar tool', m('handle_bar_diameter'), m('handle_bar_length'), (0, hub_y, shaft_z), 'X', rubber)
    boolean(handle, bar, 'UNION')
    # The handle is a single named mesh, with rubber on its transverse grip.
    if rubber.name not in [mat.name for mat in handle.data.materials]:
        handle.data.materials.append(rubber)
    grip_slot = list(handle.data.materials).index(rubber)
    for poly in handle.data.polygons:
        if abs(poly.center.x) > m('handle_hub_diameter') / 2 + m('handle_material_transition'):
            poly.material_index = grip_slot
    origin(handle, (0, hub_y, shaft_z))
    parent_keep_world(handle, screw)
    parts.append(handle)

    block = box('Block', (m('bridge_length'), m('bridge_width'), m('bridge_height')),
                (0, 0, jaw_top + m('bridge_height') / 2), steel)
    arm_span = m('board_width') + 2 * web_depth
    for x in (-m('support_arm_x'), m('support_arm_x')):
        arm = box('Bridge support tool', (m('support_arm_width'), arm_span, m('support_arm_height')),
                  (x, 0, jaw_top + m('support_arm_height') / 2))
        boolean(block, arm, 'UNION')
    for x in P['guide_hole_x']:
        hole = cylinder('Guide hole tool', m('bushing_body_diameter') + m('fit_clearance_diameter'),
                        m('bridge_height') + m('boolean_overshoot'), (x * MM, 0, jaw_top + m('bridge_height') / 2))
        boolean(block, hole)
    parent_keep_world(block, near)
    block['support'] = 'Near-jaw cantilever while open; both jaws support the arms when closed'
    parts.append(block)

    bushings = []
    for name, x in zip(('BushingCentre', 'BushingLeft', 'BushingRight'), P['bushing_x']):
        bushing = cylinder(name, m('bushing_body_diameter'), m('bushing_body_length'),
                           (x * MM, 0, jaw_top + m('bushing_body_length') / 2), mat=steel)
        flange = cylinder('Flange tool', m('bushing_flange_diameter'), m('bushing_flange_height'),
                          (x * MM, 0, jaw_top + m('bushing_body_length') + m('bushing_flange_height') / 2))
        boolean(bushing, flange, 'UNION')
        bore = cylinder('Bushing bore tool', m('bushing_bore'),
                        m('bushing_body_length') + m('bushing_flange_height') + m('boolean_overshoot'),
                        (x * MM, 0, jaw_top + m('bushing_bore_tool_offset')))
        boolean(bushing, bore)
        origin(bushing, (x * MM, 0, jaw_top))
        parent_keep_world(bushing, block)
        bushings.append(bushing)
        parts.append(bushing)

    flange_top = jaw_top + m('bridge_height') + m('bushing_flange_height')
    # The bit's stroke ends with its tip on the board's top face.
    tip_final = m('board_height')
    tip_start = flange_top + m('bit_initial_gap')
    point_length = m('bit_point_length')
    bit = cylinder('Bit', m('bit_diameter'), m('bit_length') - point_length,
                   (0, 0, tip_start + (m('bit_length') + point_length) / 2), mat=steel)
    bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=0, radius2=m('bit_diameter') / 2,
                                    depth=point_length, location=(0, 0, tip_start + point_length / 2))
    tip = bpy.context.object
    for face in tip.data.polygons:
        face.use_smooth = False
    boolean(bit, tip, 'UNION')
    for phase in (0, math.pi):
        flute = helical_cutter('Flute tool', m('bit_flute_path_radius'), m('bit_flute_length'), m('bit_flute_pitch'), m('bit_flute_radius'),
                               center=(0, 0, tip_start + m('bit_flute_centre')),
                               phase=phase, steps_per_turn=64)
        boolean(bit, flute)
    origin(bit, (0, 0, tip_start))
    parent_keep_world(bit, block)
    parts.append(bit)

    # One Blender action, with a slot for each moving object. Every slot is
    # keyed at every frame, including inherited movements on the parent chain.
    action = bpy.data.actions.new('close')
    movers = [near, far, screw, handle, block, *bushings, bit]
    rest = {obj.name: obj.location.copy() for obj in movers}
    for obj in movers:
        obj.animation_data_create()
        slot = action.slots.new(id_type='OBJECT', name=obj.name)
        obj.animation_data.action = action
        obj.animation_data.action_slot = slot
        obj.rotation_mode = 'XYZ'
    for frame in range(P['last_frame'] + 1):
        closure = min(frame / CLAMPED, 1)
        seating = min(max((frame - CLAMPED) / (SEATED - CLAMPED), 0), 1)
        drilling = min(max((frame - SEATED) / (P['last_frame'] - SEATED), 0), 1)
        for obj in movers:
            obj.location = rest[obj.name]
            obj.rotation_euler = (0, 0, 0)
        near.location.y -= m('opening_per_jaw') * (1 - closure)
        far.location.y += m('opening_per_jaw') * (1 - closure)
        screw.rotation_euler.y = -math.tau * 2 * closure - math.pi / 2 * drilling
        for bushing in bushings[1:]:
            bushing.location.z += m('bushing_lift') * (1 - seating)
        bit.location.z = rest[bit.name].z + (tip_final - tip_start) * drilling
        for obj in movers:
            obj.keyframe_insert(data_path='location', frame=frame)
            obj.keyframe_insert(data_path='rotation_euler', frame=frame)
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = 'LINEAR'
    for frame, label in zip(POSES, ('OPEN', 'CLAMPED', 'BUSHINGS SEATED', 'BIT AT BOARD')):
        scene.timeline_markers.new(label, frame=frame)
    scene.frame_set(0)
    bpy.context.view_layer.update()

    # Recompute flat/smooth boundaries without smoothing any box surfaces.
    for obj in parts:
        obj.data.name = obj.name + 'Mesh'
        obj['units'] = 'metres'
    uv_report, _ = apply_uv(parts, P)
    (ROOT / 'uv-validation.json').write_text(json.dumps(uv_report, indent=2))
    setup_render(scene)
    return parts


def setup_render(scene):
    world = bpy.data.worlds.new('White studio')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.35
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.film_transparent = True
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    render = tree.nodes.new('CompositorNodeRLayers')
    white = tree.nodes.new('CompositorNodeAlphaOver')
    white.inputs[1].default_value = (1, 1, 1, 1)
    tree.links.new(render.outputs['Image'], white.inputs[2])
    output = tree.nodes.new('CompositorNodeComposite')
    tree.links.new(white.outputs['Image'], output.inputs['Image'])
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'Medium High Contrast'
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    bpy.ops.object.camera_add(location=(-0.42, -0.65, 0.49))
    camera = bpy.context.object
    camera.name = 'PreviewCamera'
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 0.46
    camera.data.clip_start = 0.001
    camera.data.clip_end = 10
    aim(camera, (0, -0.005, 0.077))
    scene.camera = camera
    for name, position, power, size in [
        ('Key light', (-0.3, -0.4, 0.65), 3.5, 0.45),
        ('Fill light', (0.4, -0.1, 0.3), 1.5, 0.35),
        ('Rim light', (0.1, 0.35, 0.5), 3, 0.3),
    ]:
        bpy.ops.object.light_add(type='AREA', location=position)
        light = bpy.context.object
        light.name = name
        light.data.energy = power
        light.data.shape = 'DISK'
        light.data.size = size
        aim(light, (0, 0, 0.03))
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 50 if '--quick' in sys.argv else 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.use_freestyle = True
    scene.render.line_thickness = 1.15
    fs = scene.view_layers[0].freestyle_settings
    fs.crease_angle = math.radians(135)
    line_set = fs.linesets[0]
    line_set.select_silhouette = True
    line_set.select_border = True
    line_set.select_crease = True
    line_set.select_external_contour = True
    line_set.linestyle.color = (0.025, 0.03, 0.035)
    line_set.linestyle.thickness = 1.15


def frame_camera(parts, padding=1.16):
    """Keep the fixed three-quarter angle and fit the entire current pose."""
    scene = bpy.context.scene
    camera = scene.camera
    inverse = camera.matrix_world.inverted()
    points = [inverse @ (obj.matrix_world @ Vector(corner)) for obj in parts for corner in obj.bound_box]
    lo = [min(v[i] for v in points) for i in (0, 1)]
    hi = [max(v[i] for v in points) for i in (0, 1)]
    offset = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 0))
    camera.location += camera.matrix_world.to_3x3() @ offset
    aspect = scene.render.resolution_x / scene.render.resolution_y
    camera.data.ortho_scale = max(hi[0] - lo[0], (hi[1] - lo[1]) * aspect) * padding
    bpy.context.view_layer.update()
    for obj in parts:
        for corner in obj.bound_box:
            screen = world_to_camera_view(scene, camera, obj.matrix_world @ Vector(corner))
            assert 0 < screen.x < 1 and 0 < screen.y < 1, (obj.name, tuple(screen))


def validate(parts):
    scene = bpy.context.scene
    by_name = {obj.name: obj for obj in parts}
    counts = triangle_counts(parts)
    assert sum(counts.values()) < 60000, counts
    report = {'parameters_mm': P, 'triangles': counts, 'total_triangles': sum(counts.values()),
              'checks': {}, 'frames': {}, 'notes': [
                  f"Board: {P['board_length']} x {P['board_width']} x {P['board_height']} mm box, bottom Z=0.",
                  f"Jaws: {P['jaw_length']} mm X; {P['jaw_web_depth']} mm web depth plus "
                  f"{P['jaw_foot_extension']} mm inward foot; base Z={P['jaw_base_z']}, top Z={P['bridge_base_z']}.",
                  f"Rods: {P['rod_length']} mm; screw: {P['screw_length']} mm; all shaft axes Z={P['shaft_z']} mm.",
                  f"Guide bar: {P['bridge_length']} x {P['bridge_width']} x {P['bridge_height']} mm, at "
                  f"Z={P['bridge_base_z']}; two {P['support_arm_width']} x "
                  f"{P['board_width'] + 2 * P['jaw_web_depth']} x {P['support_arm_height']} mm support arms.",
                  'Bushings and bit follow the bridge horizontally, preserving alignment; insertion strokes are vertical.',
                  'Only intended mating contacts are permitted; no overlapping solid volumes.',
                  f"Frames 0 through {P['last_frame']} are {P['last_frame'] + 1} baked samples over "
                  f"{P['last_frame'] / P['fps']:g} seconds at {P['fps']} fps.",
              ]}
    assert set(by_name) == {'Board', 'JawNear', 'JawFar', 'RodLeft', 'RodRight', 'Screw',
                            'Handle', 'Block', 'BushingCentre', 'BushingLeft', 'BushingRight', 'Bit'}
    assert len(bpy.data.actions) == 1 and bpy.data.actions[0].name == 'close'
    manifold = {}
    for obj in parts:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        manifold[obj.name] = {'non_manifold_edges': sum(not e.is_manifold for e in bm.edges),
                              'volume_m3': abs(bm.calc_volume())}
        bm.free()
        assert manifold[obj.name]['non_manifold_edges'] == 0, (obj.name, manifold[obj.name])
        assert tuple(obj.scale) == (1.0, 1.0, 1.0), obj.name
    report['checks']['manifold'] = manifold
    for frame in POSES:
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        near, far = by_name['JawNear'], by_name['JawFar']
        assert abs(near.matrix_world.translation.y + far.matrix_world.translation.y) < 1e-7
        block_top = max((by_name['Block'].matrix_world @ v.co).z for v in by_name['Block'].data.vertices)
        origins = {name: [round(v / MM, 5) for v in obj.matrix_world.translation] for name, obj in by_name.items()}
        for name in ('BushingCentre', 'BushingLeft', 'BushingRight'):
            bush = by_name[name]
            expected_lift = 0 if name == 'BushingCentre' or frame >= SEATED else P['bushing_lift']
            assert abs((bush.matrix_world.translation.z + m('bushing_body_length') - block_top) / MM - expected_lift) < 1e-4
        report['frames'][str(frame)] = {'origins_mm': origins, 'symmetric_jaws': True,
                                        'bushing_heights_correct': True}
    tip = by_name['Bit'].matrix_world.translation
    centre = by_name['BushingCentre'].matrix_world.translation
    assert (tip.xy - centre.xy).length < 1e-7
    assert abs(tip.z - m('board_height')) < 1e-7
    report['checks']['bit_aligned_with_centre_bushing'] = True
    report['checks']['bit_tip_at_board_surface'] = True
    report['checks']['animation'] = {'name': 'close', 'fps': P['fps'], 'start': 0, 'end': P['last_frame'],
                                      'duration_seconds': P['last_frame'] / P['fps'],
                                      'slots': len(bpy.data.actions[0].slots)}
    (ROOT / 'validation.json').write_text(json.dumps(report, indent=2))
    scene.frame_set(0)
    return report


def export(parts):
    scene = bpy.context.scene
    scene.frame_set(0)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.export_scene.gltf(
        filepath=str(ROOT / 'doweling-jig.glb'), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_cameras=False, export_lights=False,
        export_draco_mesh_compression_enable=False, export_texcoords=True,
        export_animations=True, export_animation_mode='ACTIONS', export_merge_animation='ACTION',
        export_force_sampling=True, export_frame_range=True, export_frame_step=1,
        export_optimize_animation_size=False, export_anim_slide_to_zero=True,
        export_extras=True,
    )


if __name__ == '__main__':
    parts = build()
    report = validate(parts)
    print('JIG_TRIANGLES', report['total_triangles'], flush=True)
    export(parts)
    (ROOT / 'parameters.json').write_text(json.dumps(P, indent=2))
    # Embed the editable builder and parameters in the blend as well as beside it.
    for filename in ('build.py', 'primitives.py', 'uv_map.py'):
        bpy.data.texts.load(str(ROOT / filename))
    bpy.data.texts.new('parameters.json').write(json.dumps(P, indent=2))
    frame_camera(parts)
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'doweling-jig.blend'))
    if '--no-render' not in sys.argv:
        for frame in POSES:
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            frame_camera(parts)
            prefix = 'check' if '--quick' in sys.argv else 'frame'
            bpy.context.scene.render.filepath = str(ROOT / f'{prefix}-{frame:03d}.png')
            bpy.ops.render.render(write_still=True)
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    frame_camera(parts)
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'doweling-jig.blend'))
