"""Primitive and Boolean helpers for the parametric doweling-jig scene.

All lengths passed to these functions are in metres. No image assets are used.
Run inside Blender 4.5 or newer.
"""

import math
import bpy
from mathutils import Vector


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_geometry_transform(obj):
    activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def material(name, color, metallic=0.0, roughness=0.5):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1.0)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    return mat


def box(name, size, center, mat=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    apply_geometry_transform(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj


def cylinder(name, diameter, length, center, axis='Z', mat=None, sides=64):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=sides, radius=diameter / 2, depth=length,
        end_fill_type='NGON', location=center,
    )
    obj = bpy.context.object
    obj.name = name
    # Smooth cylindrical walls only. Caps and all box faces stay flat.
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    if axis == 'Y':
        obj.rotation_euler.x = -math.pi / 2
    elif axis == 'X':
        obj.rotation_euler.y = math.pi / 2
    apply_geometry_transform(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj


def boolean(obj, tool, operation='DIFFERENCE'):
    activate(obj)
    modifier = obj.modifiers.new(f'{operation}_{tool.name}', 'BOOLEAN')
    modifier.operation = operation
    modifier.solver = 'EXACT'
    modifier.object = tool
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(tool, do_unlink=True)


def origin(obj, location):
    activate(obj)
    bpy.context.scene.cursor.location = location
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')


def parent_keep_world(obj, parent):
    world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_parent_inverse.identity()
    obj.matrix_world = world
    bpy.context.view_layer.update()


def helical_cutter(name, radius, length, pitch, groove_radius,
                   center=(0, 0, 0), axis='Z', phase=0, handedness=1,
                   steps_per_turn=40):
    """Sweep a circular primitive along a helix for a physical Boolean groove."""
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 1
    curve.bevel_depth = groove_radius
    curve.bevel_resolution = 0
    curve.use_fill_caps = True
    spline = curve.splines.new('POLY')
    count = math.ceil(length / pitch * steps_per_turn)
    spline.points.add(count)
    for i, point in enumerate(spline.points):
        z = -length / 2 + length * i / count
        angle = handedness * (z / pitch) * math.tau + phase
        x, y = radius * math.cos(angle), radius * math.sin(angle)
        if axis == 'Y':
            position = (x, z, -y)
        else:
            position = (x, y, z)
        point.co = (*[position[j] + center[j] for j in range(3)], 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    activate(obj)
    bpy.ops.object.convert(target='MESH')
    return bpy.context.object


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def triangle_counts(objects):
    counts = {}
    for obj in objects:
        if obj.type == 'MESH':
            obj.data.calc_loop_triangles()
            counts[obj.name] = len(obj.data.loop_triangles)
    return counts
