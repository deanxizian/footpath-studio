import test from "node:test";
import assert from "node:assert/strict";
import { Group, OrthographicCamera, Vector3 } from "three";
import { createDemoRun } from "../src/demo.js";
import {
  runFromRaw,
  mergeRuns,
  targetSpeedOptions,
} from "../src/history-model.js";
import { FootpathScene } from "../src/scene.js";

test("distinct retained imports remain independently addressable", () => {
  const first = createDemoRun(0);
  const second = structuredClone(first);
  second.segments[0].points.push([0, 0, 0]);
  const runs = mergeRuns(
    [],
    [runFromRaw(first, "first"), runFromRaw(second, "second")],
  );
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map((run) => run.id)).size, 2);
  for (const run of runs)
    assert.equal(
      runs.find((candidate) => candidate.id === run.id).data,
      run.data,
    );
});

test("slow and fast default targets remain selectable after choosing another speed", () => {
  for (const speed of [1.25, 6.75]) {
    const runs = [{ rows: [{ speed }, { speed }, { speed }] }];
    const options = targetSpeedOptions(runs, 3.5);
    assert.ok(options.includes(speed.toFixed(2)));
    assert.ok(options.includes("3.50"));
    assert.deepEqual(
      options.map(Number),
      options.map(Number).sort((a, b) => a - b),
    );
  }
});

test("linked cameras preserve destination center and copy relative pan, direction and zoom", () => {
  const source = {
    center: new Vector3(10, 20, 30),
    controls: { target: new Vector3(11, 22, 33) },
    camera: new OrthographicCamera(),
    view: "free",
  };
  source.camera.position.set(13, 25, 37);
  source.camera.up.set(0, 0, 1);
  source.camera.lookAt(source.controls.target);
  source.camera.zoom = 2.5;
  const destination = {
    center: new Vector3(-10, -20, -30),
    controls: { target: new Vector3() },
    camera: new OrthographicCamera(),
    updateLabelVisibility() {},
  };
  FootpathScene.prototype.copyCamera.call(destination, source);
  assert.deepEqual(destination.controls.target.toArray(), [-9, -18, -27]);
  assert.deepEqual(destination.camera.position.toArray(), [-7, -15, -23]);
  assert.deepEqual(
    destination.camera.quaternion.toArray(),
    source.camera.quaternion.toArray(),
  );
  assert.equal(destination.camera.zoom, 2.5);
  assert.deepEqual(source.controls.target.toArray(), [11, 22, 33]);
});

function comparisonScene() {
  return Object.assign(Object.create(FootpathScene.prototype), {
    camera: new OrthographicCamera(-1, 1, 1, -1, 0.01, 100),
    controls: { target: new Vector3(), update() {}, enableDamping: true },
    cloud: new Group(),
    grid: new Group(),
    selected: new Group(),
    visibleSides: { 1: true, 2: true },
    opacity: 0,
    view: "3d",
    makeGrid() {},
    updateLabelVisibility() {},
  });
}

function comparisonData(min, max) {
  return {
    segments: [{ side: 1, points: [min, max] }],
    viewBounds: { min, max },
  };
}

test("scrubbing within fixed bounds preserves a manually positioned camera", () => {
  const scene = comparisonScene();
  const data = comparisonData([-1, -0.1, 0], [0, 0.1, 0.3]);
  scene.setData(data, false, true);
  scene.view = "free";
  scene.camera.position.set(2, -4, 3);
  scene.camera.zoom = 1.5;
  scene.controls.target.set(0.2, 0.1, 0.3);
  const next = structuredClone(data);
  next.segments[0].points = [
    [-0.6, 0, 0.1],
    [-0.1, 0.1, 0.2],
  ];
  scene.setData(next, false, true);
  assert.equal(scene.view, "free");
  assert.equal(scene.camera.zoom, 1.5);
  assert.deepEqual(scene.camera.position.toArray(), [2, -4, 3]);
  assert.deepEqual(scene.controls.target.toArray(), [0.2, 0.1, 0.3]);
});

test("changing baseline bounds recenters and fits the complete comparison", () => {
  const scene = comparisonScene();
  scene.view = "side";
  scene.setData(comparisonData([-1, -0.1, 0], [0, 0.1, 0.3]), false, true);
  const initialZoom = scene.camera.zoom;
  for (const [min, max] of [
    [
      [-4, -1, 0],
      [1, 1, 2],
    ],
    [
      [4, 1, 0],
      [9, 3, 2],
    ],
  ]) {
    scene.setData(comparisonData(min, max), false, true);
    assert.equal(scene.view, "side");
    assert.ok(scene.camera.zoom < initialZoom);
    assert.deepEqual(
      scene.controls.target.toArray(),
      min.map((v, i) => (v + max[i]) / 2),
    );
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) {
          const projected = new Vector3(x, y, z).project(scene.camera);
          assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1);
        }
  }
});
