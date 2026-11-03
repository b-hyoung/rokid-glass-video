"""2412호 데모의 기기 모델(메타 퀘스트 2, 애플 비전 프로, MS 홀로렌즈 2, 스마트홈 모형)을 블렌더로 만든다.

    blender -b --factory-startup --python tools/build_devices.py -- demo/2412

결과: devices.glb(+ tools/devices_src/Devices2412.blend). 각 기기는 DEV_<이름> 아래에 거치대·부속품과
인식 대상인 DEV_<이름>_Body를 둔다. 원점 = 책상 윗면, 앞(화면 쪽) = -Y, 위 = +Z. 치수는 실제 제품 근사값.
"""
import math
import os
import sys

import bmesh
import bpy

OUT = os.path.abspath(sys.argv[sys.argv.index('--') + 1])
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'devices_src')
os.makedirs(SRC, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
_m = {}


def lin(c):
    return tuple((v / 255) ** 2.2 for v in c)


def mat(name, rgb, rough=0.5, metal=0.0, emit=None, estr=1.0, alpha=1.0):
    if name in _m:
        return _m[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*lin(rgb), 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit:
        p.inputs['Emission Color'].default_value = (*lin(emit), 1)
        p.inputs['Emission Strength'].default_value = estr
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except AttributeError:
            m.blend_method = 'BLEND'
    m.diffuse_color = (*lin(rgb), alpha)
    _m[name] = m
    return m


def empty(name, parent=None, loc=(0, 0, 0)):
    o = bpy.data.objects.new(name, None)
    sc.collection.objects.link(o)
    o.parent = parent
    o.location = loc
    return o


def from_bm(name, bm, m, parent, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    sc.collection.objects.link(o)
    o.parent = parent
    o.location, o.rotation_euler, o.scale = loc, rot, scale
    return o


def rbox(name, size, m, parent, loc=(0, 0, 0), bevel=0.0, seg=4, rot=(0, 0, 0), sub=0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    o = from_bm(name, bm, m, parent, loc, rot, smooth=bool(bevel or sub))
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width, b.segments, b.limit_method = bevel, seg, 'NONE'
        try:
            b.harden_normals = True
        except AttributeError:
            pass
    if sub:
        s = o.modifiers.new('sub', 'SUBSURF')
        s.levels = s.render_levels = sub
    return o


def cyl(name, r, h, m, parent, loc=(0, 0, 0), rot=(0, 0, 0), n=32, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=n, radius1=r, radius2=r if r2 is None else r2, depth=h)
    o = from_bm(name, bm, m, parent, loc, rot, smooth=False)
    o.data.polygons.foreach_set('use_smooth', [len(p.vertices) == 4 for p in o.data.polygons])
    return o


def sphere(name, r, m, parent, loc=(0, 0, 0), scale=(1, 1, 1), keep=None, u=48, v=24):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    if keep:
        bmesh.ops.delete(bm, geom=[x for x in bm.verts if not keep(x.co)], context='VERTS')
    return from_bm(name, bm, m, parent, loc, scale=scale)


def torus(name, R, r, m, parent, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), nu=64, nv=16, arc=2 * math.pi):
    bm = bmesh.new()
    closed = arc >= 2 * math.pi - 1e-6
    cols = nu if closed else nu + 1
    rings = []
    for i in range(cols):
        a = arc * i / nu
        ring = []
        for j in range(nv):
            b = 2 * math.pi * j / nv
            ring.append(bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b))))
        rings.append(ring)
    for i in range(nu if closed else nu):
        a, b2 = rings[i], rings[(i + 1) % cols]
        for j in range(nv):
            bm.faces.new((a[j], b2[j], b2[(j + 1) % nv], a[(j + 1) % nv]))
    return from_bm(name, bm, m, parent, loc, rot, scale)


# 공용 재질
ALU = mat('Aluminum', (196, 199, 204), 0.25, 0.9)
DARKALU = mat('DarkAluminum', (58, 60, 64), 0.35, 0.8)
MATTE = mat('MatteBlack', (26, 27, 29), 0.6)
GLOSS = mat('GlossBlack', (8, 9, 11), 0.05, 0.2)
CAM = mat('CameraLens', (5, 5, 6), 0.08, 0.5)


def stand(parent):  # 헤드셋 거치대(무광 회색 받침 + 기둥 + 받침대)
    cyl('Stand_Base', 0.075, 0.012, DARKALU, parent, (0, 0, 0.006), n=48)
    cyl('Stand_Post', 0.009, 0.25, ALU, parent, (0, 0, 0.137), n=24)
    rbox('Stand_Cradle', (0.06, 0.05, 0.022), DARKALU, parent, (0, 0, 0.27), bevel=0.009)


# ───── 메타 퀘스트 2 ─────
def quest(name):
    root = empty(f'DEV_{name}')
    stand(root)
    body = empty(f'DEV_{name}_Body', root, (0, 0, 0.335))
    white = mat('QuestWhite', (238, 238, 234), 0.42)
    strap = mat('QuestStrap', (214, 214, 208), 0.8)
    foam = mat('QuestFoam', (38, 38, 40), 0.95)
    rbox('Q_Shell', (0.19, 0.092, 0.102), white, body, (0, -0.012, 0), bevel=0.03, seg=8)
    rbox('Q_FrontPlate', (0.15, 0.004, 0.06), mat('QuestPlate', (230, 230, 226), 0.35), body, (0, -0.058, 0), bevel=0.0018, seg=2)
    for x in (-0.072, 0.072):
        for z in (-0.03, 0.03):
            cyl('Q_Cam', 0.0062, 0.004, CAM, body, (x, -0.0585, z), (math.pi / 2, 0, 0), n=24)
    rbox('Q_Foam', (0.168, 0.034, 0.086), foam, body, (0, 0.048, -0.003), bevel=0.014, seg=4)
    rbox('Q_Nose', (0.04, 0.03, 0.03), foam, body, (0, 0.04, -0.045), bevel=0.012)
    torus('Q_Strap', 0.098, 0.011, strap, body, (0, 0.13, 0.002), scale=(1.0, 1.32, 1.0))
    rbox('Q_BackPad', (0.09, 0.022, 0.055), strap, body, (0, 0.258, 0), bevel=0.01)
    rbox('Q_Power', (0.004, 0.012, 0.006), MATTE, body, (0.096, 0.0, -0.025), bevel=0.0015)
    for s in (-1, 1):  # 컨트롤러 한 쌍(앞쪽 책상 위)
        c = empty(f'{name}_Controller', root, (s * 0.075, -0.15, 0))
        rbox('QC_Grip', (0.034, 0.095, 0.03), white, c, (0, 0.02, 0.017), bevel=0.013, seg=5)
        torus('QC_Ring', 0.043, 0.0065, white, c, (s * -0.01, -0.045, 0.03), (math.radians(70), 0, 0), nu=48, nv=10)
        rbox('QC_Face', (0.036, 0.04, 0.008), MATTE, c, (0, -0.02, 0.034), bevel=0.003)
        for dy in (-0.028, -0.012):
            cyl('QC_Btn', 0.005, 0.004, mat('QuestBtn', (60, 60, 62), 0.4), c, (s * 0.006, dy, 0.039), n=16)
    return root


# ───── 애플 비전 프로 ─────
def vision():
    root = empty('DEV_VisionPro')
    stand(root)
    body = empty('DEV_VisionPro_Body', root, (0, 0, 0.335))
    knit = mat('KnitBand', (122, 122, 120), 1.0)
    seal = mat('LightSeal', (178, 178, 174), 0.95)
    rbox('V_Glass', (0.195, 0.05, 0.098), GLOSS, body, (0, -0.022, 0), bevel=0.034, seg=8, sub=1)
    rbox('V_Frame', (0.2, 0.03, 0.103), ALU, body, (0, 0.006, 0), bevel=0.03, seg=8)
    rbox('V_Seal', (0.178, 0.036, 0.086), seal, body, (0, 0.036, -0.002), bevel=0.016, seg=4)
    torus('V_Band', 0.095, 0.018, knit, body, (0, 0.14, 0), scale=(1.02, 1.28, 1.8), nv=20)
    for s in (-1, 1):
        rbox('V_AudioStrap', (0.012, 0.065, 0.022), mat('StrapWhite', (232, 232, 228), 0.5), body, (s * 0.1, 0.055, 0.004), bevel=0.005)
    cyl('V_Crown', 0.0085, 0.009, ALU, body, (0.075, 0.0, 0.054), n=32)
    rbox('V_TopButton', (0.03, 0.008, 0.004), ALU, body, (-0.07, 0.0, 0.053), bevel=0.0018)
    cyl('V_Dial', 0.012, 0.01, ALU, body, (0.098, 0.2, 0.0), (0, math.pi / 2, 0), n=32)
    bat = empty('VisionPro_Battery', root, (0.0, -0.15, 0))  # 배터리 팩(앞쪽 책상 위)
    rbox('V_Battery', (0.105, 0.062, 0.018), ALU, bat, (0, 0, 0.009), bevel=0.008, seg=5)
    torus('V_Cable', 0.05, 0.0025, mat('CableWhite', (236, 236, 232), 0.5), bat, (0.09, 0.03, 0.003), nu=48, nv=8)
    return root


# ───── MS 홀로렌즈 2 ─────
def hololens():
    root = empty('DEV_HoloLens2')
    stand(root)
    body = empty('DEV_HoloLens2_Body', root, (0, 0, 0.33))
    band = mat('HoloBand', (32, 33, 36), 0.55)
    visor = mat('HoloVisor', (96, 70, 130), 0.04, 0.6, alpha=0.62)
    torus('H_Ring', 0.1, 0.013, band, body, (0, 0.085, 0.03), scale=(1.0, 1.18, 1.35), nv=20)
    rbox('H_Brow', (0.2, 0.06, 0.046), MATTE, body, (0, -0.035, 0.03), bevel=0.02, seg=6)
    rbox('H_SensorBar', (0.17, 0.004, 0.014), GLOSS, body, (0, -0.0665, 0.038), bevel=0.002)
    for x in (-0.06, 0.06):
        cyl('H_Cam', 0.006, 0.004, CAM, body, (x, -0.069, 0.038), (math.pi / 2, 0, 0), n=24)
    sphere('H_Visor', 0.13, visor, body, (0, 0.045, 0.02), scale=(1.0, 1.0, 1.0),
           keep=lambda c: c.y < -0.085 and -0.085 < c.z < 0.01)
    rbox('H_Pack', (0.11, 0.06, 0.075), MATTE, body, (0, 0.215, 0.02), bevel=0.022, seg=6)
    cyl('H_Wheel', 0.022, 0.012, mat('HoloWheel', (70, 72, 76), 0.4), body, (0, 0.249, 0.02), (math.pi / 2, 0, 0), n=40)
    rbox('H_Pad', (0.16, 0.012, 0.03), mat('HoloPad', (60, 60, 64), 0.95), body, (0, -0.002, 0.02), bevel=0.005)
    return root


# ───── 스마트홈 모형 ─────
def smarthome():
    root = empty('DEV_SmartHome')
    body = empty('DEV_SmartHome_Body', root)
    white = mat('HomeWhite', (242, 240, 234), 0.6)
    wood = mat('HomeWood', (176, 132, 92), 0.6)
    roof = mat('HomeRoof', (58, 60, 64), 0.5)
    glow = mat('HomeWindow', (255, 214, 150), 0.3, emit=(255, 214, 150), estr=2.0)
    grass = mat('HomeGrass', (112, 158, 82), 0.9)
    leaf = mat('HomeLeaf', (88, 138, 70), 0.85)
    rbox('S_Base', (0.6, 0.4, 0.024), white, body, (0, 0, 0.012), bevel=0.006)
    rbox('S_Grass', (0.57, 0.37, 0.006), grass, body, (0, 0, 0.027), bevel=0.002)
    rbox('S_Path', (0.06, 0.13, 0.004), mat('HomePath', (200, 196, 186), 0.8), body, (0.06, -0.125, 0.031))
    # 1층(흰 벽) + 2층(나무) + 평지붕 + 태양광
    rbox('S_Floor1', (0.34, 0.22, 0.15), white, body, (-0.05, 0.04, 0.105), bevel=0.004)
    rbox('S_Roof1', (0.37, 0.25, 0.012), roof, body, (-0.05, 0.04, 0.186), bevel=0.003)
    rbox('S_Floor2', (0.21, 0.2, 0.11), wood, body, (-0.1, 0.05, 0.247), bevel=0.003)
    rbox('S_Roof2', (0.24, 0.23, 0.012), roof, body, (-0.1, 0.05, 0.308), bevel=0.003)
    for k, x in enumerate((-0.15, -0.05)):
        rbox(f'S_Solar{k}', (0.085, 0.16, 0.006), mat('HomeSolar', (28, 44, 84), 0.15, 0.3), body, (x, 0.05, 0.321), rot=(math.radians(12), 0, 0))
    rbox('S_Win1', (0.15, 0.004, 0.08), glow, body, (-0.1, -0.0715, 0.11))
    rbox('S_Win1Frame', (0.155, 0.003, 0.004), roof, body, (-0.1, -0.0725, 0.11))
    rbox('S_Win2', (0.13, 0.004, 0.06), glow, body, (-0.1, -0.0515, 0.25))
    rbox('S_Door', (0.05, 0.004, 0.1), wood, body, (0.06, -0.0715, 0.08))
    rbox('S_Lock', (0.008, 0.004, 0.016), MATTE, body, (0.075, -0.074, 0.085))
    cyl('S_PorchLight', 0.007, 0.006, glow, body, (0.06, -0.074, 0.15), (math.pi / 2, 0, 0), n=16)
    cyl('S_Cctv', 0.008, 0.03, mat('HomeCctv', (236, 236, 236), 0.4), body, (0.11, -0.065, 0.17), (math.radians(60), 0, 0), n=16)
    # IoT 기기: 스마트 스피커(파란 LED 링), 스마트 가로등, 허브 태블릿
    cyl('S_Speaker', 0.03, 0.08, mat('SpeakerFabric', (70, 72, 76), 0.95), body, (0.2, -0.07, 0.07), n=40)
    torus('S_SpeakerLED', 0.024, 0.003, mat('SpeakerLED', (80, 180, 255), 0.3, emit=(80, 180, 255), estr=4.0), body, (0.2, -0.07, 0.111), nu=40, nv=8)
    for k, (x, y) in enumerate(((0.24, 0.1), (-0.25, -0.15))):
        cyl(f'S_LampPost{k}', 0.004, 0.14, DARKALU, body, (x, y, 0.1), n=12)
        sphere(f'S_LampBulb{k}', 0.018, glow, body, (x, y, 0.18), u=24, v=12)
    rbox('S_Hub', (0.07, 0.008, 0.05), MATTE, body, (0.2, 0.12, 0.06), bevel=0.003, rot=(math.radians(-12), 0, 0))
    rbox('S_HubScreen', (0.062, 0.002, 0.042), mat('HubScreen', (60, 160, 255), 0.2, emit=(60, 160, 255), estr=2.5), body, (0.2, 0.1155, 0.061), rot=(math.radians(-12), 0, 0))
    for k, (x, y, h) in enumerate(((-0.24, 0.14, 0.1), (-0.26, -0.05, 0.08))):  # 나무
        cyl(f'S_Trunk{k}', 0.008, h, wood, body, (x, y, 0.03 + h / 2), n=12)
        sphere(f'S_Leaf{k}', 0.045, leaf, body, (x, y, 0.03 + h + 0.025), scale=(1, 1, 1.2), u=24, v=12)
    return root


quest('Quest2')
vision()
hololens()
smarthome()

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SRC, 'Devices2412.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'devices.glb'), export_format='GLB', export_yup=True, export_apply=True)
print('OK', len(sc.objects))
