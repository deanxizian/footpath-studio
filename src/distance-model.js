import { paceSeries, summarizeClean } from "./analysis-model.js";

// Footpath archives contain sampled speed, not a cumulative-distance stream.
// Integrate speed once along the run timeline, then calibrate to activity distance.
export function distanceProfile(run) {
  const samples = new Map();
  for (const row of run.rows) {
    const time = row.time - run.startTime;
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      time > run.duration ||
      !Number.isFinite(row.speed) ||
      row.speed < 0
    )
      continue;
    const sample = samples.get(time) ?? { time, sum: 0, n: 0 };
    sample.sum += row.speed;
    sample.n++;
    samples.set(time, sample);
  }
  const knots = [...samples.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ time, sum, n }) => ({ time, speed: sum / n, meters: 0 }));
  const unavailable = {
    available: false,
    estimated: true,
    totalKm: null,
    knots: [],
    scale: 0,
  };
  if (!knots.length || !Number.isFinite(run.duration) || run.duration <= 0)
    return unavailable;
  if (knots[0].time > 0) knots.unshift({ ...knots[0], time: 0 });
  if (knots.at(-1).time < run.duration)
    knots.push({ ...knots.at(-1), time: run.duration });
  for (let i = 1; i < knots.length; i++) {
    const previous = knots[i - 1],
      current = knots[i];
    current.meters =
      previous.meters +
      ((current.time - previous.time) * (previous.speed + current.speed)) / 2;
  }
  const integrated = knots.at(-1).meters;
  if (!Number.isFinite(integrated) || integrated <= 0) return unavailable;
  const hasRecordedTotal =
    Number.isFinite(run.activity?.distance) && run.activity.distance > 0;
  const totalMeters = hasRecordedTotal ? run.activity.distance : integrated;
  return {
    available: true,
    estimated: true,
    totalKm: totalMeters / 1000,
    hasRecordedTotal,
    knots,
    scale: totalMeters / integrated,
  };
}

export function distanceAtTime(profile, time) {
  if (!profile.available || !Number.isFinite(time)) return null;
  const { knots, scale } = profile;
  if (time <= knots[0].time) return 0;
  if (time >= knots.at(-1).time) return profile.totalKm;
  let low = 0,
    high = knots.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (knots[middle].time <= time) low = middle;
    else high = middle;
  }
  const a = knots[low],
    b = knots[high],
    elapsed = time - a.time;
  const meters =
    a.meters +
    a.speed * elapsed +
    ((b.speed - a.speed) * elapsed * elapsed) / (2 * (b.time - a.time));
  return (meters * scale) / 1000;
}

export function selectDistanceStage(
  run,
  profile,
  { start = 0, end = profile.totalKm } = {},
) {
  const total = profile.totalKm ?? 0;
  const clamp = (value) => Math.min(total, Math.max(0, value));
  const first = Number.isFinite(start) ? clamp(start) : 0;
  const last = Number.isFinite(end) ? clamp(end) : total;
  start = Math.min(first, last);
  end = Math.max(first, last);
  const fullRange = !profile.available || (start === 0 && end === total);
  const rows = fullRange
    ? run.eligible
    : run.eligible.filter((row) => {
        const distance = distanceAtTime(profile, row.time - run.startTime);
        return (
          distance !== null &&
          distance >= start &&
          (distance < end || (end === total && distance <= total))
        );
      });
  return {
    start,
    end,
    fullRange,
    rows,
    summary: fullRange ? run.summary : summarizeClean(rows, run.summary),
  };
}

export function distancePaceSeries(run, profile) {
  if (!profile.available) return [];
  return paceSeries(run).map((row) => ({
    distance: distanceAtTime(profile, row.time),
    pace: row.pace,
  }));
}
