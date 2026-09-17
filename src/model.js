export const COLORS = { left: "#ff981f", right: "#3d91ff", ink: "#edf0f4" };
export const CENTIMETERS_PER_METER = 100;

export function normalizeData(input, fileName = "Stryd Footpath") {
  const packed = input?.format === "footpath-studio-v1";
  const source = packed ? input.segments : input?.foot_data_list;
  if (!Array.isArray(source) || !source.length) {
    throw new Error("文件需要包含非空的 foot_data_list 轨迹列表。");
  }
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  let pointCount = 0;
  const segments = source.map((s, index) => {
    if (s.side !== 1 && s.side !== 2)
      throw new Error(`第 ${index + 1} 个片段的左右脚标记无法识别。`);
    const positions = s.points ?? s.positions;
    if (!Array.isArray(positions) || positions.length < 2)
      throw new Error(`第 ${index + 1} 个片段缺少三维坐标。`);
    const points = positions.map((p, pi) => {
      const v = Array.isArray(p) ? [...p] : [p.x, p.y, p.z];
      if (v.length !== 3 || !v.every(Number.isFinite))
        throw new Error(`片段 ${index + 1} 的第 ${pi + 1} 个坐标无效。`);
      v.forEach((n, axis) => {
        bounds.min[axis] = Math.min(bounds.min[axis], n);
        bounds.max[axis] = Math.max(bounds.max[axis], n);
      });
      return v;
    });
    const timestamp = s.timestamp;
    const timestampFrac = s.timestamp_frac ?? 0;
    if (!Number.isFinite(timestamp) || !Number.isFinite(timestampFrac))
      throw new Error(`第 ${index + 1} 个片段的时间戳无效。`);
    pointCount += points.length;
    return {
      index,
      side: s.side,
      points,
      timestamp,
      timestampFrac,
      time: timestamp + timestampFrac,
      speed: s.speed,
      power: s.power,
      groundContactTime: s.ground_contact_time,
      strideTime: s.stride_time,
      sampleFreq: s.sample_freq,
    };
  });
  if (bounds.min.every((value, axis) => value === bounds.max[axis])) {
    throw new Error("所有坐标都相同，无法形成三维轨迹。");
  }
  const start = segments.reduce(
    (value, segment) => Math.min(value, segment.time),
    Infinity,
  );
  const end = segments.reduce(
    (value, segment) => Math.max(value, segment.time),
    -Infinity,
  );
  return {
    title:
      typeof input.title === "string"
        ? input.title
        : fileName.replace(/\.json$/i, ""),
    segments,
    pointCount,
    bounds,
    start,
    end,
    leftCount: segments.filter((s) => s.side === 1).length,
    rightCount: segments.filter((s) => s.side === 2).length,
  };
}

export function pairedIndices(data, selectedIndex) {
  const selected = data.segments[selectedIndex];
  let nearest = -1;
  let gap = Infinity;
  for (const segment of data.segments) {
    const delta = Math.abs(segment.time - selected.time);
    if (segment.side !== selected.side && delta < gap) {
      gap = delta;
      nearest = segment.index;
    }
  }
  // Do not imply that an unrelated distant segment is the paired step.
  return nearest >= 0 && gap <= 1.5
    ? [selectedIndex, nearest]
    : [selectedIndex];
}

export function plotPoint(point, side, mirror) {
  // Stryd's visualizer converts raw Y to -Y before plotting in 3D.
  // Apply the optional left-foot overlay after that coordinate conversion.
  const y = -point[1];
  return [point[0], mirror && side === 1 ? -y : y, point[2]];
}

export function lineSegmentPositions(segments, side, mirror) {
  const count = segments.reduce(
    (total, s) => total + (s.side === side ? s.points.length - 1 : 0),
    0,
  );
  const result = new Float32Array(count * 6);
  let offset = 0;
  for (const s of segments) {
    if (s.side !== side) continue;
    for (let i = 1; i < s.points.length; i++) {
      result.set(plotPoint(s.points[i - 1], side, mirror), offset);
      result.set(plotPoint(s.points[i], side, mirror), offset + 3);
      offset += 6;
    }
  }
  return result;
}

export const number = (value) => new Intl.NumberFormat("en-US").format(value);
export const footName = (side) => (side === 1 ? "左脚" : "右脚");
export const clockTime = (timestamp) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp * 1000));
export const dateText = (timestamp) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp * 1000));
export function elapsed(seconds) {
  const n = Math.max(0, Math.round(seconds));
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
}
export const metric = (value, unit, digits = 0) =>
  Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : "—";
