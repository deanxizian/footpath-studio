import test from "node:test";
import assert from "node:assert/strict";
import { OrthographicCamera, Vector3 } from "three";
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
