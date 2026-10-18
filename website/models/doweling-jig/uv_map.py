"""Metric, deterministic UV coordinates; no geometry or material changes.

One UV unit represents 100 mm. Charts are translated, never scaled or rotated
by the layout packer. Cylinder V follows the positive local shaft axis.
"""
import math
from collections import defaultdict

import bpy
import numpy as np
from mathutils import Vector

STABILIZATION = {}
TAU = math.tau
SEAM_DIRECTION = Vector((-1, 2, -2))
BASES = {
    'X': (Vector((0, 1, 0)), Vector((0, 0, 1)), Vector((1, 0, 0))),
    'Y': (Vector((1, 0, 0)), Vector((0, 0, -1)), Vector((0, 1, 0))),
    'Z': (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))),
}


def cylinder_chart(obj, face, axis, radius, centre=(0, 0, 0), inside=False):
    a, b, along = BASES[axis]
    centre = Vector(centre)
    # Develop the actual 64-sided surface. U is chord arclength, so its
    # metric is exact for the mesh rather than the ideal circular surface.
    step = TAU / 64
    chord = 2 * radius * math.sin(step / 2)
    seam_index = round(math.atan2(SEAM_DIRECTION.dot(b), SEAM_DIRECTION.dot(a)) / step)
    radial = face.center - centre
    sector = math.floor(math.atan2(radial.dot(b), radial.dot(a)) / step)
    mid = (sector + .5) * step
    tangent = -math.sin(mid) * a + math.cos(mid) * b
    result=[]
    for vertex in face.vertices:
        point=obj.data.vertices[vertex].co-centre
        fraction=(point.dot(tangent)+chord/2)/chord
        around=(sector-seam_index) % 64 + fraction
        result.append(((-1 if inside else 1)*chord*around,point.dot(along)))
    return result


def planar_chart(obj, face, axis=None, sign=None):
    n = face.normal
    axis = max(range(3), key=lambda i: abs(n[i])) if axis is None else axis
    sign = (1 if n[axis] >= 0 else -1) if sign is None else sign
    # U points along +X wherever X lies in the face. X-normal faces use +Y.
    u, v = ((1, 2) if axis == 0 else (0, 2) if axis == 1 else (0, 1))
    v_sign = sign * (-1 if axis == 1 else 1)
    values = [(obj.data.vertices[i].co[u], obj.data.vertices[i].co[v] * v_sign)
              for i in face.vertices]
    return values, ('plane', axis, sign, round(face.center[axis], 6))


def surface(obj, face, p):
    name = obj.name
    mm = lambda key: p[key] * 0.001
    points = [obj.data.vertices[i].co for i in face.vertices]
    n = face.normal
    if name in ('RodLeft', 'RodRight', 'Screw'):
        if abs(n.y) > 0.99999:
            return (*planar_chart(obj, face), 'planar')
        radius = mm('screw_diameter' if name == 'Screw' else 'rod_diameter') / 2
        return cylinder_chart(obj, face, 'Y', radius), ('cylinder',), 'cylindrical'
    if name.startswith('Bushing'):
        if abs(n.z) > 0.99999:
            return (*planar_chart(obj, face), 'planar')
        r = math.hypot(face.center.x, face.center.y)
        if r < mm('bushing_bore') / 2 + 0.0001:
            radius, kind, inside = mm('bushing_bore') / 2, 'bore', True
        elif face.center.z > mm('bushing_body_length') + 1e-6:
            radius, kind, inside = mm('bushing_flange_diameter') / 2, 'flange-rim', False
        else:
            radius, kind, inside = mm('bushing_body_diameter') / 2, 'body', False
        return cylinder_chart(obj, face, 'Z', radius, inside=inside), ('cylinder', kind), 'cylindrical'
    if name == 'Bit':
        if abs(n.z) > 0.99999:
            return (*planar_chart(obj, face), 'planar')
        tip_height = p['bit_point_length'] * 0.001
        if max(v.z for v in points) <= tip_height + 1e-7 and n.z < -0.7:
            uv, _ = planar_chart(obj, face, axis=2, sign=-1)
            return uv, ('point-cap',), 'point-planar'
        return cylinder_chart(obj, face, 'Z', mm('bit_diameter') / 2), ('cylinder',), 'cylindrical'
    if name == 'Handle':
        radius = p['handle_bar_diameter'] * 0.001 / 2
        if abs(n.x) < 1e-5 and all(abs(math.hypot(v.y, v.z) - radius) < 1e-5 for v in points):
            return cylinder_chart(obj, face, 'X', radius), ('bar',), 'cylindrical'
        uv, key = planar_chart(obj, face)
        if abs(face.center.x) > p['handle_hub_diameter'] * 0.001 / 2 + 0.001:
            return uv, key, 'planar'
        # The round hub deliberately uses the requested local-axis box projection.
        return uv, ('hub-box', *key[1:3]), 'hub-box'
    if name in ('JawNear', 'JawFar'):
        centre_z = mm('shaft_z') - mm('jaw_base_z')
        if abs(n.y) < 1e-4:
            for x, diameter in [(-mm('rod_x'), mm('rod_diameter')),
                                (0, mm('screw_diameter')), (mm('rod_x'), mm('rod_diameter'))]:
                r = (diameter + mm('fit_clearance_diameter')) / 2
                if all(abs(math.hypot(v.x - x, v.z - centre_z) - r) < 1e-5 for v in points):
                    return cylinder_chart(obj, face, 'Y', r, (x, 0, centre_z), True), ('bore', x), 'cylindrical'
    if name == 'Block' and abs(n.z) < 1e-4:
        r = (mm('bushing_body_diameter') + mm('fit_clearance_diameter')) / 2
        for x_mm in p['guide_hole_x']:
            x = x_mm * 0.001
            if all(abs(math.hypot(v.x - x, v.y) - r) < 1e-5 for v in points):
                return cylinder_chart(obj, face, 'Z', r, (x, 0, 0), True), ('bore', x), 'cylindrical'
    return (*planar_chart(obj, face), 'planar')


def connected_islands(obj, coords, keys):
    parents = list(range(len(obj.data.polygons)))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    uses = defaultdict(list)
    for face in obj.data.polygons:
        for i, loop in enumerate(face.loop_indices):
            nxt = face.loop_indices[(i + 1) % len(face.loop_indices)]
            a = obj.data.loops[loop].vertex_index
            b = obj.data.loops[nxt].vertex_index
            pair = (coords[loop], coords[nxt]) if a < b else (coords[nxt], coords[loop])
            uses[tuple(sorted((a, b)))].append((face.index, pair))
    for uses_of_edge in uses.values():
        if len(uses_of_edge) != 2:
            continue
        (a, ua), (b, ub) = uses_of_edge
        if keys[a] != keys[b]:
            continue
        if max(abs(ua[i][j] - ub[i][j]) for i in range(2) for j in range(2)) < 1e-7:
            parents[root(b)] = root(a)
    groups = defaultdict(list)
    for face in obj.data.polygons:
        groups[root(face.index)].append(face.index)
    return list(groups.values())


def metric_face(obj, face, triangles):
    """Develop the existing polygon triangles without changing mesh topology."""
    mesh = obj.data
    todo = [tuple(t.vertices) for t in triangles[face.index]]
    points = {v: np.array(mesh.vertices[v].co[:], dtype=float) for v in face.vertices}
    # Seed with the largest triangle for numerical stability.
    todo.sort(key=lambda t: -np.linalg.norm(np.cross(points[t[1]]-points[t[0]], points[t[2]]-points[t[0]])))
    a,b,c = todo.pop(0)
    ab = points[b]-points[a]
    length = np.linalg.norm(ab)
    tangent = ab / length
    x = np.dot(points[c]-points[a], tangent)
    y = np.linalg.norm(points[c]-points[a]-x*tangent)
    values = {a: np.array([0.,0.]), b: np.array([length,0.]), c: np.array([x,y])}
    for iteration in range(len(todo)+1):
        pending = []
        progress = False
        for tri in todo:
            known = [v in values for v in tri]
            if all(known):
                continue
            if sum(known) != 2:
                pending.append(tri)
                continue
            k = known.index(False)
            a,b,c = tri[(k+1)%3],tri[(k+2)%3],tri[k]
            ab = values[b]-values[a]
            length = np.linalg.norm(ab)
            if length < 1e-18:
                values[c] = values[a].copy()
                continue
            la = np.linalg.norm(points[c]-points[a])
            lb = np.linalg.norm(points[c]-points[b])
            x = (la*la-lb*lb+length*length)/(2*length)
            y = math.sqrt(max(0.,la*la-x*x))
            along = ab/length
            values[c] = values[a]+x*along+y*np.array([-along[1],along[0]])
            progress = True
        todo = pending
        if not todo:
            break
        assert progress, (obj.name,face.index,'polygon triangulation disconnected')
    assert not todo
    # Orient U with the projected local X axis, or the cylindrical tangent
    # for recessed shaft faces. This is an orientation-preserving rotation.
    n=np.array(face.normal[:],dtype=float)
    if obj.name in ('Screw','Bit'):
        axis=np.array([0,1,0] if obj.name=='Screw' else [0,0,1],dtype=float)
        radial=np.array(face.center[:],dtype=float)
        radial-=axis*np.dot(radial,axis)
        desired=np.cross(axis,radial)
    else:
        desired=np.array([1.,0.,0.])
    desired-=n*np.dot(desired,n)
    if np.linalg.norm(desired)<1e-8:
        desired=np.array([0.,1.,0.])-n*n[1]
    desired/=np.linalg.norm(desired)
    a,b,c=triangles[face.index][0].vertices
    # Fit world tangent components to the developed coordinates.
    source=np.array([values[b]-values[a],values[c]-values[a]])
    target=np.array([np.dot(points[b]-points[a],desired),np.dot(points[c]-points[a],desired)])
    if abs(np.linalg.det(source))>1e-20:
        direction=np.linalg.solve(source,target)
        direction/=np.linalg.norm(direction)
    else:
        direction=np.array([1.,0.])
    rot=np.array([[direction[0],direction[1]],[-direction[1],direction[0]]])
    return [tuple(rot@values[v]) for v in face.vertices]


def outer_land(obj, face, axis, radius):
    indices=(0,2) if axis=='Y' else (0,1)
    return abs(face.normal[1 if axis=='Y' else 2])<1e-5 and all(
        radius*math.cos(math.pi/64)-1e-7 <= math.hypot(obj.data.vertices[v].co[indices[0]],obj.data.vertices[v].co[indices[1]]) <= radius+1e-7
        for v in face.vertices)


def stabilize_uv(mesh, coords, charts):
    nodes, loop_node, values = {}, {}, []
    for ci,chart in enumerate(charts):
        for loop in chart['loops']:
            key=(ci,mesh.loops[loop].vertex_index,round(coords[loop][0],6),round(coords[loop][1],6))
            if key not in nodes:
                nodes[key]=len(values)
                values.append(coords[loop])
            loop_node[loop]=nodes[key]
    uv=np.array(values,dtype=np.float32).astype(float)
    original=uv.copy()
    ids=np.array([[loop_node[i] for i in t.loops] for t in mesh.loop_triangles])
    for iteration in range(300):
        tri=uv[ids]
        a,b=tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]
        signed=a[:,0]*b[:,1]-a[:,1]*b[:,0]
        bad=np.flatnonzero(signed<=1e-12)
        if not len(bad):
            break
        for k in bad:
            indices=ids[k]
            q=uv[indices]
            a,b=q[1]-q[0],q[2]-q[0]
            signed=a[0]*b[1]-a[1]*b[0]
            grad=np.array([[a[1]-b[1],b[0]-a[0]],[b[1],-b[0]],[-a[1],a[0]]])
            norm=(grad*grad).sum()
            if norm<1e-20:continue
            # A minimum displacement survives float32 storage at large UVs.
            step=max((2e-11-signed)/norm, 3e-7/math.sqrt(norm))
            uv[indices]=(q+step*grad).astype(np.float32).astype(float)
    for loop,index in loop_node.items():coords[loop]=tuple(uv[index])
    return float(np.linalg.norm(uv-original,axis=1).max())


def unwrap_object(obj, p):
    mesh = obj.data
    mesh.update()
    coords, keys, kinds = {}, {}, {}
    scale = 1000 / p['uv_unit_mm']
    mesh.calc_loop_triangles()
    triangles=defaultdict(list)
    for tri in mesh.loop_triangles:
        triangles[tri.polygon_index].append(tri)
    for face in mesh.polygons:
        values, key, kind = surface(obj, face, p)
        axis='Y' if obj.name=='Screw' else 'Z'
        is_groove = obj.name in ('Screw','Bit') and kind=='cylindrical' and not outer_land(obj,face,axis,p['screw_diameter' if obj.name=='Screw' else 'bit_diameter']*.0005)
        is_tip = kind=='point-planar'
        is_hub = kind=='hub-box' and max(abs(v) for v in face.normal)<0.99999
        if is_groove or is_tip or is_hub:
            values=metric_face(obj,face,triangles)
            key=('metric-face',face.index)
            kind='recess-metric' if is_groove else 'tip-metric' if is_tip else 'hub-facet-metric'
        keys[face.index], kinds[face.index] = key, kind
        for loop, value in zip(face.loop_indices, values):
            coords[loop] = (value[0] * scale, value[1] * scale)
    islands = connected_islands(obj, coords, keys)
    charts = []
    for faces in islands:
        loops = [loop for f in faces for loop in mesh.polygons[f].loop_indices]
        lo = [min(coords[loop][i] for loop in loops) for i in range(2)]
        hi = [max(coords[loop][i] for loop in loops) for i in range(2)]
        charts.append({'faces': faces, 'loops': loops, 'lo': lo, 'hi': hi,
                       'kind': kinds[faces[0]]})
    charts.sort(key=lambda chart: (-(chart['hi'][1] - chart['lo'][1]), min(chart['faces'])))
    gap = p['uv_island_gap_mm'] / p['uv_unit_mm']
    period = 2 * p['uv_checker_mm'] / p['uv_unit_mm']
    area = sum((c['hi'][0] - c['lo'][0] + gap) * (c['hi'][1] - c['lo'][1] + gap) for c in charts)
    width = max(max(c['hi'][0] - c['lo'][0] for c in charts) + 2 * period, math.sqrt(area) * 1.4)
    x, y, row_top = gap, gap, gap
    for chart in charts:
        chart_width = chart['hi'][0] - chart['lo'][0]
        if x + chart_width + period > width and x > gap:
            x, y = gap, row_top + gap
        if chart['kind'].endswith('metric'):
            offset=[x-chart['lo'][0], y-chart['lo'][1]]
        else:
            offset = [math.ceil((x - chart['lo'][0]) / period) * period,
                      math.ceil((y - chart['lo'][1]) / period) * period]
        for loop in chart['loops']:
            coords[loop] = tuple(coords[loop][i] + offset[i] for i in range(2))
        chart['bounds'] = [[chart['lo'][i] + offset[i] for i in range(2)],
                           [chart['hi'][i] + offset[i] for i in range(2)]]
        x = chart['bounds'][1][0] + gap
        row_top = max(row_top, chart['bounds'][1][1])
    max_shift = stabilize_uv(mesh, coords, charts)
    STABILIZATION[obj.name] = max_shift * p['uv_unit_mm']
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    layer = mesh.uv_layers.new(name='UVMap', do_init=False)
    layer.active_render = True
    for loop in mesh.loops:
        layer.data[loop.index].uv = coords[loop.index]
    mesh.update()
    return charts, kinds


def metrics(obj, charts, kinds, p):
    mesh = obj.data
    mesh.calc_loop_triangles()
    data = mesh.uv_layers['UVMap'].data
    groups = defaultdict(list)
    flipped, collapsed, tiny = [], [], []
    all_nonpositive = 0
    for tri in mesh.loop_triangles:
        points = np.array([mesh.vertices[i].co[:] for i in tri.vertices], dtype=float)
        uv = np.array([data[i].uv[:] for i in tri.loops], dtype=float)
        e1, e2 = points[1] - points[0], points[2] - points[0]
        cross = np.cross(e1, e2)
        area = np.linalg.norm(cross) / 2
        u, v = uv[1] - uv[0], uv[2] - uv[0]
        signed = u[0] * v[1] - u[1] * v[0]
        all_nonpositive += int(signed <= 0)
        if area < 1e-12:
            tiny.append(tri.index)
            continue
        if signed < -1e-12:
            flipped.append(tri.index)
        if abs(signed) < 1e-13:
            collapsed.append(tri.index)
        length = np.linalg.norm(e1)
        tangent = e1 / length
        x2 = np.dot(e2, tangent)
        y2 = np.linalg.norm(e2 - tangent * x2)
        jac = np.column_stack((u, v)) @ np.linalg.inv(np.array([[length, x2], [0, y2]]))
        singular = np.linalg.svd(jac, compute_uv=False) / (1000 / p['uv_unit_mm'])
        groups[kinds[tri.polygon_index]].append((area, *singular))
    result = {'islands': len(charts), 'flipped_triangle_count': len(flipped),
              'collapsed_triangle_count': len(collapsed), 'source_triangles_below_1e_6_mm2': len(tiny), 'flipped_examples': flipped[:12], 'surface_metrics': {}, 'all_triangle_nonpositive_count': all_nonpositive,
              'max_float32_stabilization_mm': STABILIZATION.get(obj.name, 0)}
    for kind, values in groups.items():
        a = np.array(values)
        error=np.max(np.abs(a[:,1:]-1),axis=1)
        order=np.argsort(error)
        cumulative=np.cumsum(a[order,0])/a[:,0].sum()
        quantile=float(error[order[min(len(order)-1,np.searchsorted(cumulative,.999))]])
        result['surface_metrics'][kind] = {
            'area_weighted_99_9_percentile_scale_error': quantile,
            'area_mm2': float(a[:, 0].sum() * 1e6),
            'scale_min': float(a[:, 1:].min()), 'scale_max': float(a[:, 1:].max()),
            'area_weighted_scale': [float(np.average(a[:, i], weights=a[:, 0])) for i in (1, 2)],
        }
    return result


def apply_uv(parts, p):
    """Unwraps every part but those named in uv_skip, which keep no UV layer
    (the screw's thread is drawn by its own edges, and its UVs would be most
    of the exported file)."""
    report = {}
    layouts = {}
    for obj in parts:
        if obj.name in p.get('uv_skip', ()):
            while obj.data.uv_layers:
                obj.data.uv_layers.remove(obj.data.uv_layers[0])
            continue
        charts, kinds = unwrap_object(obj, p)
        report[obj.name] = metrics(obj, charts, kinds, p)
        assert report[obj.name]['all_triangle_nonpositive_count'] == 0, (obj.name, 'nonpositive UV triangle')
        assert report[obj.name]['max_float32_stabilization_mm'] < .005, (obj.name, 'UV adjustment exceeds five micrometres')
        layouts[obj.name] = charts
        print('UV', obj.name, report[obj.name], flush=True)
    return report, layouts
