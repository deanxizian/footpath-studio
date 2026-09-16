import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { COLORS, lineSegmentPositions, plotPoint } from "./model";

function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose();
    if (o.material) {
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const material of materials) {
        material.map?.dispose();
        material.dispose();
      }
    }
  });
  group.clear();
}

function label(text, position, size = 0.028, dimension = "") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  context.font = "500 44px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#929da9";
  context.fillText(text, 128, 48);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
    }),
  );
  sprite.position.set(...position);
  sprite.scale.set((size * 256) / 96, size, 1);
  sprite.userData.axisLabel = true;
  sprite.userData.isAxisName = /^[XYZ]$/.test(text);
  sprite.userData.dimension = dimension;
  return sprite;
}

export class FootpathScene {
  constructor(container, onInteract) {
    this.container = container;
    this.width = container.clientWidth;
    this.height = container.clientHeight;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#12151a");
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.labelDirection = new THREE.Vector3();
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-label", "可旋转的三维足部轨迹");
    this.renderer.domElement.setAttribute("role", "img");
    container.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.minZoom = 0.25;
    this.controls.maxZoom = 15;
    this.onInteract = () => {
      this.view = "free";
      this.updateLabelVisibility("free");
      onInteract?.();
    };
    this.controls.addEventListener("start", this.onInteract);
    this.cloud = new THREE.Group();
    this.selected = new THREE.Group();
    this.grid = new THREE.Group();
    this.scene.add(this.grid, this.cloud, this.selected);
    this.materials = [];
    this.markers = [];
    this.visibleSides = { 1: true, 2: true };
    this.mirror = false;
    this.mode = "overlay";
    this.view = "3d";
    this.phase = 0;
    this.opacity = 0.08;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.animate = () => {
      if (this.disposed) return;
      this.controls.update();
      this.updateLabelScale();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(this.animate);
    };
    this.resize();
    this.animate();
  }

  resize() {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    const ratio = this.width / this.height;
    this.camera.left = -ratio * 0.5;
    this.camera.right = ratio * 0.5;
    this.camera.top = 0.5;
    this.camera.bottom = -0.5;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
    for (const material of this.materials)
      material.resolution.set(this.width, this.height);
    if (this.data) this.fit();
  }

  updateLabelScale() {
    this.updateLabelVisibility();
    for (const sprite of this.grid.children) {
      if (!sprite.userData.axisLabel) continue;
      const pixels = sprite.userData.isAxisName
        ? 14
        : this.width < 600
          ? 10
          : 11;
      const height = (pixels * 96) / 44 / (this.height * this.camera.zoom);
      sprite.scale.set((height * 256) / 96, height, 1);
    }
  }

  setData(data, mirror) {
    this.data = data;
    this.mirror = mirror;
    disposeGroup(this.cloud);
    disposeGroup(this.grid);
    this.box = new THREE.Box3();
    for (const segment of data.segments) {
      for (const p of segment.points)
        this.box.expandByPoint(
          new THREE.Vector3(...plotPoint(p, segment.side, mirror)),
        );
    }
    if (data.viewBounds) {
      this.box.min.set(...data.viewBounds.min);
      this.box.max.set(...data.viewBounds.max);
    }
    this.center = this.box.getCenter(new THREE.Vector3());
    for (const side of [1, 2]) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(
          lineSegmentPositions(data.segments, side, mirror),
          3,
        ),
      );
      const material = new THREE.LineBasicMaterial({
        color: side === 1 ? COLORS.left : COLORS.right,
        transparent: true,
        opacity: this.opacity,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(geometry, material);
      lines.userData.side = side;
      this.cloud.add(lines);
    }
    this.makeGrid();
    this.setView(this.view === "free" ? "3d" : this.view);
    this.applyVisibility();
  }

  makeGrid() {
    const b = this.box;
    const extent = Math.max(
      b.max.x - b.min.x,
      b.max.y - b.min.y,
      b.max.z - b.min.z,
    );
    const step = 10 ** Math.floor(Math.log10(extent / 7));
    const gridStep = extent / step > 15 ? step * 2 : step;
    const lower = [b.min.x, b.min.y, Math.min(0, b.min.z)].map(
      (n) => Math.floor(n / gridStep) * gridStep,
    );
    const upper = [b.max.x, b.max.y, b.max.z].map(
      (n) => Math.ceil(n / gridStep) * gridStep,
    );
    const padding = gridStep;
    lower[0] -= padding;
    lower[1] -= padding;
    upper[0] += padding;
    upper[1] += padding;
    const vertices = [];
    const add = (a, c) => vertices.push(...a, ...c);
    for (let x = lower[0]; x <= upper[0] + 1e-8; x += gridStep)
      add([x, lower[1], 0], [x, upper[1], 0]);
    for (let y = lower[1]; y <= upper[1] + 1e-8; y += gridStep)
      add([lower[0], y, 0], [upper[0], y, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    this.grid.add(
      new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: "#2b323c" }),
      ),
    );
    const line = (start, end) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...start),
        new THREE.Vector3(...end),
      ]);
      this.grid.add(
        new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#55616e" })),
      );
    };
    line([lower[0], 0, 0], [upper[0], 0, 0]);
    line([0, lower[1], 0], [0, upper[1], 0]);
    line([0, 0, lower[2]], [0, 0, upper[2] + gridStep * 0.55]);
    const fontSize = extent * 0.045;
    this.grid.add(
      label("X", [upper[0] + gridStep * 0.3, 0, 0], fontSize * 1.3, "x"),
    );
    this.grid.add(
      label("Y", [0, b.max.y + gridStep * 0.35, 0], fontSize * 1.3, "y"),
    );
    this.grid.add(
      label("Z", [0, 0, upper[2] + gridStep * 0.8], fontSize * 1.3, "z"),
    );
    for (let z = gridStep; z <= upper[2] + 1e-8; z += gridStep) {
      line([0, 0, z], [gridStep * 0.1, 0, z]);
      this.grid.add(
        label(
          Number(z.toFixed(4)).toString(),
          [gridStep * 0.36, 0, z],
          fontSize,
          "z",
        ),
      );
    }
    // Sparse ticks keep the canvas legible while rotating.
    for (let x = lower[0]; x <= upper[0] + 1e-8; x += gridStep * 2) {
      this.grid.add(
        label(
          Number(x.toFixed(4)).toString(),
          [x, lower[1] - gridStep * 0.23, 0],
          fontSize,
          "x",
        ),
      );
    }
    for (let y = lower[1]; y <= upper[1] + 1e-8; y += gridStep * 2) {
      if (
        Math.abs(y) > 1e-8 &&
        y >= b.min.y - gridStep * 0.75 &&
        y <= b.max.y + gridStep * 0.75
      )
        this.grid.add(
          label(
            Number(y.toFixed(4)).toString(),
            [upper[0] + gridStep * 0.35, y, 0],
            fontSize,
            "y",
          ),
        );
    }
  }

  updateLabelVisibility() {
    const direction = this.camera.getWorldDirection(this.labelDirection);
    const hidden =
      Math.abs(direction.z) > 0.985
        ? "z"
        : Math.abs(direction.y) > 0.985
          ? "y"
          : Math.abs(direction.x) > 0.985
            ? "x"
            : undefined;
    for (const item of this.grid?.children ?? [])
      if (item.userData.axisLabel)
        item.visible = item.userData.dimension !== hidden;
  }

  setView(view) {
    if (!this.data) return;
    this.view = view;
    this.updateLabelVisibility(view);
    // Clear the drag's remaining inertia before applying a fixed projection.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.up.set(0, 0, 1);
    const offsets = {
      "3d": [1.35, -2.2, 1.15],
      side: [0, -3, 0],
      back: [-3, 0, 0],
      top: [0, -0.00001, 3],
    };
    const offset = offsets[view] ?? offsets["3d"];
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).add(new THREE.Vector3(...offset));
    this.camera.lookAt(this.center);
    this.controls.update();
    this.controls.enableDamping = damping;
    this.fit();
  }

  fit() {
    if (!this.box) return;
    this.camera.zoom = 1;
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
    this.updateLabelVisibility();
    let maxX = 0,
      maxY = 0;
    const padding = this.box.getSize(new THREE.Vector3()).length() * 0.13;
    const box = this.box.clone().expandByScalar(padding);
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(this.camera);
          maxX = Math.max(maxX, Math.abs(projected.x));
          maxY = Math.max(maxY, Math.abs(projected.y));
        }
    // Include visible axis labels so orthographic views keep their ticks in frame.
    for (const item of this.grid.children) {
      if (!item.userData.axisLabel || !item.visible) continue;
      const projected = item.position.clone().project(this.camera);
      maxX = Math.max(maxX, Math.abs(projected.x));
      maxY = Math.max(maxY, Math.abs(projected.y));
    }
    this.camera.zoom = 0.92 / Math.max(maxX, maxY, 0.01);
    this.camera.updateProjectionMatrix();
  }

  setSelected(indices) {
    if (!this.data) return;
    disposeGroup(this.selected);
    this.materials = [];
    this.markers = [];
    for (const index of indices) {
      const s = this.data.segments[index];
      const color = s.color ?? (s.side === 1 ? COLORS.left : COLORS.right);
      const geometry = new LineGeometry();
      geometry.setPositions(
        s.points.flatMap((p) => plotPoint(p, s.side, this.mirror)),
      );
      const material = new LineMaterial({
        color,
        linewidth: s.linewidth ?? 2.8,
        transparent: true,
        opacity: s.opacity ?? 0.96,
        depthTest: false,
        dashed: Boolean(s.dashed),
        dashSize: 0.018,
        gapSize: 0.012,
      });
      material.resolution.set(this.width, this.height);
      this.materials.push(material);
      const line = new Line2(geometry, material);
      if (s.dashed) line.computeLineDistances();
      line.userData.side = s.side;
      line.renderOrder = 5;
      this.selected.add(line);
      if (s.hideMarker) continue;
      const radius = this.box.getSize(new THREE.Vector3()).length() * 0.007;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      marker.userData.side = s.side;
      marker.userData.segment = s;
      marker.renderOrder = 10;
      this.markers.push(marker);
      this.selected.add(marker);
    }
    this.setPhase(this.phase);
    this.applyVisibility();
  }

  setPhase(phase) {
    this.phase = phase;
    for (const marker of this.markers) {
      const s = marker.userData.segment;
      const position = phase * (s.points.length - 1);
      const a = Math.floor(position);
      const b = Math.min(a + 1, s.points.length - 1);
      const t = position - a;
      const point = s.points[a].map(
        (value, axis) => value + (s.points[b][axis] - value) * t,
      );
      marker.position.set(...plotPoint(point, s.side, this.mirror));
    }
  }

  copyCamera(source) {
    this.view = source.view;
    this.updateLabelVisibility(this.view);
    this.camera.position.copy(source.camera.position);
    this.camera.quaternion.copy(source.camera.quaternion);
    this.camera.up.copy(source.camera.up);
    this.camera.zoom = source.camera.zoom;
    this.controls.target.copy(source.controls.target);
    this.camera.updateProjectionMatrix();
  }

  setDisplay(visibleSides, mode, opacity) {
    this.visibleSides = visibleSides;
    this.mode = mode;
    this.opacity = opacity;
    for (const line of this.cloud.children) line.material.opacity = opacity;
    this.applyVisibility();
  }

  applyVisibility() {
    for (const line of this.cloud.children)
      line.visible =
        this.mode === "overlay" && this.visibleSides[line.userData.side];
    for (const object of this.selected.children)
      object.visible = this.visibleSides[object.userData.side];
  }

  saveImage(subtitle) {
    this.renderer.render(this.scene, this.camera);
    const source = this.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height + 96;
    const context = canvas.getContext("2d");
    context.fillStyle = "#12151a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 96);
    context.fillStyle = COLORS.ink;
    context.font = "600 28px system-ui, sans-serif";
    context.fillText("Footpath Studio", 32, 40);
    context.fillStyle = "#6c7c8e";
    context.font = "18px system-ui, sans-serif";
    context.fillText(subtitle, 32, 70);
    context.fillStyle = COLORS.left;
    context.fillText("左脚", canvas.width - 170, 42);
    context.fillStyle = COLORS.right;
    context.fillText("右脚", canvas.width - 90, 42);
    const a = document.createElement("a");
    a.download = "footpath-3d.png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener("start", this.onInteract);
    this.controls.dispose();
    disposeGroup(this.grid);
    disposeGroup(this.cloud);
    disposeGroup(this.selected);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
