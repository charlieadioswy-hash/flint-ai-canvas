package model3d

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBlenderExportOptions(t *testing.T) {
	options, err := NormalizeExportOptions(ExportOptions{Format: "abc"})
	if err != nil || options.FPS != 30 {
		t.Fatalf("default options: %+v %v", options, err)
	}
	for _, options := range []ExportOptions{{Format: "obj"}, {Format: "abc", FPS: -1}, {Format: "fbx", FPS: 121}, {Format: "abc", Animation: "a\n"}, {Format: "abc", Animation: strings.Repeat("a", 257)}} {
		if _, err := NormalizeExportOptions(options); err == nil {
			t.Fatalf("accepted invalid options: %+v", options)
		}
	}
}

func TestBlenderSourceRejectsDependenciesAndInvalidFormats(t *testing.T) {
	for _, test := range []struct {
		format, contents, message string
	}{
		{"gltf", `{"asset":{"version":"2.0"},"buffers":[{"uri":"../../private.bin"}]}`, "外部依赖"},
		{"gltf", `{"asset":{"version":"2.0"},"images":[{"uri":"https://example.invalid/secret.png"}]}`, "外部依赖"},
		{"gltf", `{"asset":{"version":"2.0"},"extensionsRequired":["EXT_meshopt_compression"]}`, "压缩"},
		{"gltf", `{"asset":{"version":"1.0"}}`, "无效"},
		{"obj", "v 0 0 0\nmtllib ../../secrets.mtl", "外部依赖"},
		{"obj", "call /private/script.obj", "外部依赖"},
		{"stl", "not a model", "无效"},
		{"fbx", "not a model", "无效"},
	} {
		t.Run(test.format+test.message+test.contents, func(t *testing.T) {
			if err := validateConversionSource([]byte(test.contents), test.format); err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("validation: %v", err)
			}
		})
	}
}

func blenderFixtureBinary(t *testing.T, behavior string) string {
	t.Helper()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODEL3D_TEST_BINARY", binary)
	t.Setenv("MODEL3D_TEST_BEHAVIOR", behavior)
	path := filepath.Join(t.TempDir(), "blender-fixture")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexec \"$MODEL3D_TEST_BINARY\" -test.run='^TestBlenderProcessFixture$' -- \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBlenderProcessFixture(t *testing.T) {
	behavior := os.Getenv("MODEL3D_TEST_BEHAVIOR")
	if behavior == "" {
		return
	}
	var request struct {
		SourcePath string        `json:"sourcePath"`
		OutputPath string        `json:"outputPath"`
		StatusPath string        `json:"statusPath"`
		Options    ExportOptions `json:"options"`
	}
	data, err := os.ReadFile(os.Args[len(os.Args)-1])
	if err != nil || json.Unmarshal(data, &request) != nil {
		os.Exit(3)
	}
	if behavior == "block" {
		time.Sleep(20 * time.Second)
	}
	code := "ok"
	if behavior == "error" {
		code = "multiple_clips"
	} else if behavior == "symlink" {
		_ = os.Symlink(request.SourcePath, request.OutputPath)
	} else if behavior == "oversize" {
		file, _ := os.Create(request.OutputPath)
		_ = file.Truncate(MaxOutputBytes + 1)
		_ = file.Close()
	} else {
		data = append([]byte("Kaydara FBX Binary  \x00\x1a\x00"), make([]byte, 20)...)
		if request.Options.Format == "abc" {
			data = append([]byte("Ogawa\xff\x00\x01"), make([]byte, 16)...)
		}
		if behavior == "bad_magic" {
			data = []byte("not a real model")
		}
		_ = os.WriteFile(request.OutputPath, data, 0600)
	}
	status, _ := json.Marshal(map[string]string{"code": code})
	_ = os.WriteFile(request.StatusPath, status, 0600)
	os.Exit(0)
}

func blenderTriangleSource(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "triangle.obj")
	if err := os.WriteFile(path, []byte("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBlenderChildProcessAndOutputValidation(t *testing.T) {
	for _, behavior := range []string{"valid", "bad_magic", "error", "symlink", "oversize"} {
		t.Run(behavior, func(t *testing.T) {
			outputDir := t.TempDir()
			converter := NewBlenderConverter(blenderFixtureBinary(t, behavior))
			output, err := converter.Convert(context.Background(), ConversionRequest{SourcePath: blenderTriangleSource(t), SourceFormat: "obj", OutputDir: outputDir, Options: ExportOptions{Format: "fbx"}})
			if behavior == "valid" {
				if err != nil || output.FileName != "model.fbx" || output.Format != "fbx" || output.Bytes < 27 || output.MimeType != "application/vnd.autodesk.fbx" {
					t.Fatalf("conversion: %+v %v", output, err)
				}
			} else if err == nil || strings.Contains(err.Error(), outputDir) {
				t.Fatalf("unsafe or missing failure: %v", err)
			}
			files, err := os.ReadDir(outputDir)
			if err != nil || len(files) != map[bool]int{true: 1, false: 0}[behavior == "valid"] {
				t.Fatalf("temporary files retained: %v %v", files, err)
			}
		})
	}
}

func TestBlenderCancellationStopsChildAndCleansFiles(t *testing.T) {
	converter := NewBlenderConverter(blenderFixtureBinary(t, "block"))
	outputDir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := converter.Convert(ctx, ConversionRequest{SourcePath: blenderTriangleSource(t), SourceFormat: "obj", OutputDir: outputDir, Options: ExportOptions{Format: "abc"}})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > 3*time.Second {
		t.Fatalf("cancellation: %v after %v", err, time.Since(started))
	}
	files, _ := os.ReadDir(outputDir)
	if len(files) != 0 {
		t.Fatalf("cancelled conversion retained files: %v", files)
	}
}

func TestBlenderMissingBinaryAndFBXPassthrough(t *testing.T) {
	converter := NewBlenderConverter(filepath.Join(t.TempDir(), "missing-blender"))
	_, err := converter.Convert(context.Background(), ConversionRequest{SourcePath: blenderTriangleSource(t), SourceFormat: "obj", OutputDir: t.TempDir(), Options: ExportOptions{Format: "abc"}})
	if !errors.Is(err, ErrBlenderUnavailable) {
		t.Fatalf("missing binary: %v", err)
	}
	data := append([]byte("Kaydara FBX Binary  \x00\x1a\x00"), make([]byte, 20)...)
	source := filepath.Join(t.TempDir(), "source.fbx")
	_ = os.WriteFile(source, data, 0600)
	output, err := converter.Convert(context.Background(), ConversionRequest{SourcePath: source, SourceFormat: "fbx", OutputDir: t.TempDir(), Options: ExportOptions{Format: "fbx"}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(output.Path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("passthrough changed source: %v", err)
	}
}

func TestBlenderActualConversion(t *testing.T) {
	binary := os.Getenv("CANVAS_TEST_BLENDER_BIN")
	if binary == "" {
		t.Skip("CANVAS_TEST_BLENDER_BIN is not configured")
	}
	converter := NewBlenderConverter(binary)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, format := range []string{"fbx", "abc"} {
		output, err := converter.Convert(ctx, ConversionRequest{SourcePath: blenderTriangleSource(t), SourceFormat: "obj", OutputDir: t.TempDir(), Options: ExportOptions{Format: format}})
		if err != nil || output.Bytes < 32 {
			t.Fatalf("actual %s conversion: %+v %v", format, output, err)
		}
	}
	fixtureDirectory := t.TempDir()
	fixtureScript := filepath.Join(fixtureDirectory, "fixture.py")
	if err := os.WriteFile(fixtureScript, []byte(blenderAnimatedFixture), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, binary, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", fixtureScript, "--", fixtureDirectory)
	if logs, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create animated fixture: %v\n%s", err, logs)
	}
	source := filepath.Join(fixtureDirectory, "animated.glb")
	_, err := converter.Convert(ctx, ConversionRequest{SourcePath: source, SourceFormat: "glb", OutputDir: t.TempDir(), Options: ExportOptions{Format: "abc"}})
	if err == nil || !strings.Contains(err.Error(), "多个动作") {
		t.Fatalf("multiple actions silently selected: %v", err)
	}
	outputs := map[string]string{}
	for _, format := range []string{"fbx", "abc"} {
		output, err := converter.Convert(ctx, ConversionRequest{SourcePath: source, SourceFormat: "glb", OutputDir: t.TempDir(), Options: ExportOptions{Format: format, Animation: "walk", FPS: 30}})
		if err != nil {
			t.Fatalf("actual animated %s conversion: %v", format, err)
		}
		outputs[format] = output.Path
	}
	allFBX, err := converter.Convert(ctx, ConversionRequest{SourcePath: source, SourceFormat: "glb", OutputDir: t.TempDir(), Options: ExportOptions{Format: "fbx"}})
	if err != nil {
		t.Fatalf("all FBX clips: %v", err)
	}
	outputs["fbx_all"] = allFBX.Path
	_, err = converter.Convert(ctx, ConversionRequest{SourcePath: filepath.Join(fixtureDirectory, "complex.glb"), SourceFormat: "glb", OutputDir: t.TempDir(), Options: ExportOptions{Format: "fbx"}})
	if err == nil || !strings.Contains(err.Error(), "多个对象") {
		t.Fatalf("incomplete complex FBX actions accepted: %v", err)
	}
	_, err = converter.Convert(ctx, ConversionRequest{SourcePath: allFBX.Path, SourceFormat: "fbx", OutputDir: t.TempDir(), Options: ExportOptions{Format: "abc"}})
	if err == nil || !strings.Contains(err.Error(), "多个动作") {
		t.Fatalf("multiple FBX actions silently selected: %v", err)
	}
	for _, test := range []struct {
		name, source, sourceFormat, animation string
		fps                                   int
	}{
		{"fbx_source_abc", allFBX.Path, "fbx", "rig|walk", 60},
		{"jump_abc", source, "glb", "jump", 30},
		{"unnamed_abc", filepath.Join(fixtureDirectory, "unnamed.glb"), "glb", "animation_1", 30},
		{"long_walk_abc", filepath.Join(fixtureDirectory, "long-names.fbx"), "fbx", "rig|" + strings.Repeat("a", 56) + "1", 30},
		{"long_jump_abc", filepath.Join(fixtureDirectory, "long-names.fbx"), "fbx", "rig|" + strings.Repeat("a", 56) + "2", 30},
		{"unicode_walk_abc", filepath.Join(fixtureDirectory, "unicode-names.fbx"), "fbx", strings.Repeat("中文骨架", 4) + "|" + strings.Repeat("重复动作前缀", 3) + "甲", 30},
		{"unicode_jump_abc", filepath.Join(fixtureDirectory, "unicode-names.fbx"), "fbx", strings.Repeat("中文骨架", 4) + "|" + strings.Repeat("重复动作前缀", 3) + "乙", 30},
		{"long_single_abc", filepath.Join(fixtureDirectory, "long-single.fbx"), "fbx", "", 30},
	} {
		output, err := converter.Convert(ctx, ConversionRequest{SourcePath: test.source, SourceFormat: test.sourceFormat, OutputDir: t.TempDir(), Options: ExportOptions{Format: "abc", Animation: test.animation, FPS: test.fps}})
		if err != nil {
			t.Fatalf("actual %s: %v", test.name, err)
		}
		outputs[test.name] = output.Path
	}
	_, err = converter.Convert(ctx, ConversionRequest{SourcePath: source, SourceFormat: "glb", OutputDir: t.TempDir(), Options: ExportOptions{Format: "abc", Animation: "missing"}})
	if err == nil || !strings.Contains(err.Error(), "不存在") {
		t.Fatalf("missing animation: %v", err)
	}
	_, err = converter.Convert(ctx, ConversionRequest{SourcePath: filepath.Join(fixtureDirectory, "external.fbx"), SourceFormat: "fbx", OutputDir: t.TempDir(), Options: ExportOptions{Format: "abc", Animation: "Scene"}})
	if err == nil || !strings.Contains(err.Error(), "外部依赖") {
		t.Fatalf("external FBX textures accepted: %v", err)
	}
	manifest, _ := json.Marshal(outputs)
	if err := os.WriteFile(filepath.Join(fixtureDirectory, "outputs.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	verify := filepath.Join(fixtureDirectory, "verify.py")
	if err := os.WriteFile(verify, []byte(blenderVerifyFixture), 0600); err != nil {
		t.Fatal(err)
	}
	command = exec.CommandContext(ctx, binary, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", verify, "--", filepath.Join(fixtureDirectory, "outputs.json"))
	if logs, err := command.CombinedOutput(); err != nil {
		t.Fatalf("verify animated exports: %v\n%s", err, logs)
	}
}

const blenderAnimatedFixture = `
import bpy
import json
from pathlib import Path
import struct
import sys
bpy.ops.wm.read_factory_settings(use_empty=True)
directory = Path(sys.argv[sys.argv.index('--')+1])
scene = bpy.context.scene
scene.render.fps = 30
mesh = bpy.data.meshes.new('body')
mesh.from_pydata([(0,0,0),(1,0,0),(0,1,0)], [], [(0,1,2)])
mesh.uv_layers.new(name='UVMap')
for loop, uv in zip(mesh.uv_layers.active.data, [(0,0),(1,0),(0,1)]): loop.uv = uv
body = bpy.data.objects.new('body',mesh)
scene.collection.objects.link(body)
material = bpy.data.materials.new('paint')
material.use_nodes = True
image = bpy.data.images.new('paint.png', width=2, height=2)
image.pixels = [0.3,0.6,0.8,1.0]*4
image.pack()
texture = material.node_tree.nodes.new('ShaderNodeTexImage')
texture.image = image
material.node_tree.links.new(texture.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
mesh.materials.append(material)
bpy.ops.object.armature_add()
armature = bpy.context.object
armature.name = 'rig'
modifier = body.modifiers.new('skin','ARMATURE')
modifier.object = armature
body.parent = armature
body.vertex_groups.new(name='Bone').add([0,1,2],1.0,'REPLACE')
for name, delta in [('walk',(1,0,0)),('jump',(0,0,2))]:
    armature.animation_data_create()
    armature.animation_data.action = None
    bone = armature.pose.bones['Bone']
    bone.location = (0,0,0)
    bone.keyframe_insert('location',frame=1)
    bone.location = delta
    bone.keyframe_insert('location',frame=31)
    armature.animation_data.action.name = name
    armature.animation_data.action.use_fake_user = True
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=str(directory/'animated.glb'),export_format='GLB',export_animation_mode='ACTIONS',export_anim_single_armature=True)
data = (directory/'animated.glb').read_bytes()
json_length = struct.unpack_from('<I',data,12)[0]
document = json.loads(data[20:20+json_length])
remainder = data[20+json_length:]
def write_glb(name, document):
    payload = json.dumps(document,separators=(',',':')).encode()
    payload += b' ' * (-len(payload)%4)
    (directory/name).write_bytes(struct.pack('<III',0x46546C67,2,20+len(payload)+len(remainder))+struct.pack('<II',len(payload),0x4E4F534A)+payload+remainder)
complex_document = json.loads(json.dumps(document))
target = len(complex_document['nodes'])
complex_document['nodes'].append({'name':'moving_prop'})
complex_document['scenes'][complex_document.get('scene',0)]['nodes'].append(target)
for animation in complex_document['animations']:
    channel = next(channel for channel in animation['channels'] if channel['target']['path']=='translation')
    animation['channels'].append({'sampler':channel['sampler'],'target':{'node':target,'path':'translation'}})
write_glb('complex.glb',complex_document)
for animation in document['animations']: animation.pop('name',None)
write_glb('unnamed.glb',document)
bpy.ops.export_scene.fbx(filepath=str(directory/'external.fbx'),path_mode='ABSOLUTE',embed_textures=False,add_leaf_bones=False,bake_anim_use_all_actions=False,bake_anim_use_nla_strips=False)
walk = bpy.data.actions['walk']
jump = bpy.data.actions['jump']
for filename, rig_name, walk_name, jump_name in [
    ('long-names.fbx', 'rig', 'a'*56+'1', 'a'*56+'2'),
    ('unicode-names.fbx', '中文骨架'*4, '重复动作前缀'*3+'甲', '重复动作前缀'*3+'乙'),
]:
    armature.name = rig_name
    walk.name = walk_name
    jump.name = jump_name
    armature.animation_data.action = walk
    bpy.ops.export_scene.fbx(filepath=str(directory/filename),path_mode='COPY',embed_textures=True,add_leaf_bones=False,bake_anim_use_all_actions=True,bake_anim_use_nla_strips=False)
armature.name = 'rig'
walk.name = 'a'*57
bpy.data.actions.remove(jump, do_unlink=True)
armature.animation_data.action = walk
bpy.ops.export_scene.fbx(filepath=str(directory/'long-single.fbx'),path_mode='COPY',embed_textures=True,add_leaf_bones=False,bake_anim_use_all_actions=True,bake_anim_use_nla_strips=False)
`

const blenderVerifyFixture = `
import bpy
import json
from pathlib import Path
import sys
outputs = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=outputs['fbx'],use_image_search=False)
assert any(obj.type == 'ARMATURE' and len(obj.data.bones) for obj in bpy.data.objects), 'missing bones'
assert bpy.data.actions, 'missing FBX animation'
assert any(image.packed_file for image in bpy.data.images), 'missing embedded texture'
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=outputs['fbx_all'],use_image_search=False)
assert len(bpy.data.actions) == 2, [action.name for action in bpy.data.actions]
assert any(action.name.endswith('|walk') for action in bpy.data.actions), 'missing walk clip'
assert any(action.name.endswith('|jump') for action in bpy.data.actions), 'missing jump clip'
for name, expected_distance, fps in [
    ('abc',1.0,30), ('fbx_source_abc',1.0,60), ('jump_abc',2.0,30), ('unnamed_abc',1.0,30),
    ('long_walk_abc',1.0,30), ('long_jump_abc',2.0,30),
    ('unicode_walk_abc',1.0,30), ('unicode_jump_abc',2.0,30), ('long_single_abc',1.0,30),
]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = fps
    bpy.ops.wm.alembic_import(filepath=outputs[name],set_frame_range=True,as_background_job=False)
    scene = bpy.context.scene
    meshes = [obj for obj in scene.objects if obj.type == 'MESH']
    assert len(meshes) == 1, (name,'unexpected ABC geometry')
    assert scene.frame_end > scene.frame_start, (name,'static ABC animation')
    def position(frame):
        scene.frame_set(frame)
        graph = bpy.context.evaluated_depsgraph_get()
        obj = meshes[0].evaluated_get(graph)
        return obj.matrix_world @ obj.data.vertices[0].co
    start = position(scene.frame_start)
    end = position(scene.frame_end)
    assert abs((end-start).length-expected_distance) < 0.01, (name,start,end,scene.frame_start,scene.frame_end)
    assert abs((scene.frame_end-scene.frame_start)/fps-1.0) < 0.04, (name,scene.frame_start,scene.frame_end)
    assert meshes[0].data.uv_layers, (name,'missing ABC UVs')
`
