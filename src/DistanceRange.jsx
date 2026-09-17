import React, { useState } from "react";

export const RANGE_STEPS = 1000;

export default function DistanceRange({ range, onChange, totalKm, disabled }) {
  const [active, setActive] = useState(0);
  return (
    <div
      className={`distance-range${disabled ? " is-disabled" : ""}`}
      role="group"
      aria-label="公里范围"
      style={{
        "--range-start": `${range[0] / 10}%`,
        "--range-end": `${range[1] / 10}%`,
      }}
    >
      <div className="distance-range-track" aria-hidden="true">
        <div className="distance-range-selection" />
      </div>
      {[0, 1].map((endpoint) => (
        <input
          key={endpoint}
          type="range"
          min={0}
          max={RANGE_STEPS}
          step={1}
          value={range[endpoint]}
          aria-label={endpoint === 0 ? "起点公里" : "终点公里"}
          aria-valuetext={
            disabled
              ? "距离数据不足"
              : `≈ ${((totalKm * range[endpoint]) / RANGE_STEPS).toFixed(2)} km`
          }
          disabled={disabled}
          style={{ zIndex: active === endpoint ? 2 : 1 }}
          onFocus={() => setActive(endpoint)}
          onPointerDown={() => setActive(endpoint)}
          onChange={(event) => {
            const value = Number(event.target.value);
            onChange((previous) =>
              endpoint === 0
                ? [Math.min(value, previous[1] - 1), previous[1]]
                : [previous[0], Math.max(value, previous[0] + 1)],
            );
          }}
        />
      ))}
    </div>
  );
}
