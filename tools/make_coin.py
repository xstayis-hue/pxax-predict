# Генератор монетки PXAX -> glTF (GLB)
# Запуск: blender --background --python make_coin.py
import bpy
import math
import os

OUT = r"C:\Users\xstay\.lmstudio\apps\bionic\projects\d49037d8-47f4-5808-9028-c707de117f8f\workspace\pxax-predict\assets\coin.glb"

bpy.ops.wm.read_factory_settings(use_empty=True)


def make_mat(name, color, metallic, roughness, emission=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Metallic"].default_value = metallic
    p.inputs["Roughness"].default_value = roughness
    if emission:
        for nm in ("Emission Color", "Emission"):
            if nm in p.inputs:
                p.inputs[nm].default_value = (*emission, 1.0)
                break
        if "Emission Strength" in p.inputs:
            p.inputs["Emission Strength"].default_value = strength
    return m


mat_body = make_mat("CoinMetal", (0.055, 0.075, 0.13), 1.0, 0.32)
mat_cyan = make_mat("NeonCyan", (0.0, 0.25, 0.30), 0.6, 0.4, emission=(0.0, 0.90, 1.0), strength=2.5)
mat_pink = make_mat("NeonPink", (0.30, 0.05, 0.20), 0.6, 0.4, emission=(1.0, 0.16, 0.85), strength=2.5)


def assign(obj, m):
    obj.data.materials.append(m)


# --- корпус монеты ---
bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=1.0, depth=0.22, location=(0, 0, 0))
body = bpy.context.active_object
body.name = "CoinBody"
bev = body.modifiers.new("Bevel", 'BEVEL')
bev.width = 0.02
bev.segments = 5
assign(body, mat_body)

# --- неоновые ободки (циан сверху, магента снизу) ---
rims = []
for z, m in ((0.11, mat_cyan), (-0.11, mat_pink)):
    bpy.ops.mesh.primitive_torus_add(major_radius=0.955, minor_radius=0.04, location=(0, 0, z))
    rim = bpy.context.active_object
    rim.name = "RimTop" if z > 0 else "RimBot"
    assign(rim, m)
    rims.append(rim)

# --- выдавленная надпись PXAX на обеих сторонах ---
def add_text(body_str, z, flip):
    bpy.ops.object.text_add(location=(0, 0, z))
    t = bpy.context.active_object
    t.data.body = body_str
    t.data.size = 0.40
    t.data.extrude = 0.05
    t.data.bevel_depth = 0.006
    t.data.bevel_resolution = 2
    t.data.align_x = 'CENTER'
    t.data.align_y = 'CENTER'
    if flip:
        t.rotation_euler = (math.pi, 0, 0)
    bpy.ops.object.convert(target='MESH')
    mesh = bpy.context.active_object
    mesh.name = "PXAX_Top" if not flip else "PXAX_Bot"
    assign(mesh, mat_cyan if not flip else mat_pink)
    return mesh


top_txt = add_text("PXAX", 0.105, False)
bot_txt = add_text("PXAX", -0.105, True)

# --- сглаживание корпуса и ободков ---
bpy.ops.object.select_all(action='DESELECT')
for ob in (body, *rims):
    ob.select_set(True)
bpy.context.view_layer.objects.active = body
try:
    bpy.ops.object.shade_auto_smooth(angle=math.radians(40))
except Exception:
    bpy.ops.object.shade_smooth()

# --- объединяем всё в один объект ---
bpy.ops.object.select_all(action='DESELECT')
for ob in bpy.data.objects:
    ob.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
coin = bpy.context.active_object
coin.name = "PXAX_Coin"

# применяем bevel
if "Bevel" in [m.name for m in coin.modifiers]:
    bpy.ops.object.modifier_apply(modifier="Bevel")

# --- экспорт GLB ---
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=True,
    export_apply=True,
)
print("EXPORTED:", OUT, os.path.getsize(OUT), "bytes")
