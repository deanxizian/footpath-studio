import React, { memo, useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dateText, elapsed } from "./model.js";

export const FOOT_COLORS = {
  left: "#f5a23a",
  right: "#5c9bed",
  difference: "#bbc9df",
};
export const valueText = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";
export const signedText = (value, digits = 1) =>
  Number.isFinite(value)
    ? `${value > 0 ? "+" : ""}${Math.abs(value) < 0.5 * 10 ** -digits ? (0).toFixed(digits) : value.toFixed(digits)}`
    : "—";
const shortDate = (time) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).format(new Date(time * 1000));
const paceText = (value) =>
  Number.isFinite(value) ? elapsed(value * 60) : "—";

function axisBounds(rows, keys, zero = false) {
  const values = rows
    .flatMap((row) => keys.map((key) => row[key]))
    .filter(Number.isFinite);
  if (!values.length) return [0, 1];
  let low = Math.min(...values),
    high = Math.max(...values);
  if (zero) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  const padding = (high - low || Math.abs(high) * 0.1 || 1) * 0.13;
  return [low - padding, high + padding];
}

function TrendTooltip({ active, payload, metric, difference }) {
  const row = payload?.find((item) => item.payload?.id)?.payload;
  if (!active || !row) return null;
  return (
    <div className="studio-tooltip">
      <strong>{dateText(row.time)}</strong>
      {difference ? (
        <p>右 − 左 {signedText(row.difference)}%</p>
      ) : (
        <>
          <p className="foot-left">
            左脚 {valueText(row.left, metric.digits)} {metric.unit}
          </p>
          <p className="foot-right">
            右脚 {valueText(row.right, metric.digits)} {metric.unit}
          </p>
        </>
      )}
    </div>
  );
}

export const HistoryPlot = memo(function HistoryPlot({
  rows,
  metric,
  startTime,
  endTime,
  onSelect,
  difference = false,
}) {
  const keys = difference ? ["difference"] : ["left", "right"];
  const domain = axisBounds(rows, keys, difference);
  const first = startTime ?? rows[0]?.time ?? 0,
    last = endTime ?? rows.at(-1)?.time ?? 1;
  const extent = first === last ? [first - 43200, last + 43200] : [first, last];
  const ticks = Array.from(
    { length: 5 },
    (_, i) => extent[0] + ((extent[1] - extent[0]) * i) / 4,
  );
  const hasData = rows.some((row) =>
    keys.some((key) => Number.isFinite(row[key])),
  );
  const point = (field) => (props) => {
    if (!Number.isFinite(props.value) || !Number.isFinite(props.cy))
      return null;
    return (
      <circle
        key={`${props.payload.id}-${field}`}
        cx={props.cx}
        cy={props.cy}
        r={2.3}
        fill={FOOT_COLORS[field]}
        fillOpacity={0.6}
        stroke="none"
        role="button"
        tabIndex={0}
        aria-label={`选择 ${dateText(props.payload.time)} 的跑步，${field === "left" ? "左脚" : field === "right" ? "右脚" : "左右差异"}`}
        onClick={() => onSelect(props.payload.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(props.payload.id);
          }
        }}
      />
    );
  };
  return (
    <div
      className={`studio-history-plot ${difference ? "difference-plot" : "feet-plot"}`}
      data-testid={difference ? "difference-chart" : "feet-chart"}
    >
      {!hasData ? (
        <p className="chart-empty">这段时间没有足够的{metric.label}数据</p>
      ) : (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart
            data={rows}
            syncId="footpath-trends"
            margin={{ top: 12, right: 14, bottom: 4, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid stroke="#2b2f34" vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={extent}
              ticks={ticks}
              tickFormatter={shortDate}
              stroke="#383e46"
              tick={{ fill: "#969eaa", fontSize: 11 }}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              domain={domain}
              width={58}
              tickCount={5}
              tickFormatter={(value) =>
                difference
                  ? `${value.toFixed(1)}%`
                  : value.toFixed(metric.digits > 0 ? 3 : 0)
              }
              tick={{ fill: "#969eaa", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            {difference && (
              <ReferenceLine y={0} stroke="#768295" strokeDasharray="4 4" />
            )}
            <Tooltip
              content={<TrendTooltip metric={metric} difference={difference} />}
              cursor={{ stroke: "#687483", strokeDasharray: "3 3" }}
            />
            {keys.map((key) => (
              <Line
                key={`${key}-observed`}
                dataKey={key}
                stroke="none"
                dot={point(key)}
                activeDot={{
                  r: 4.5,
                  fill: FOOT_COLORS[key],
                  fillOpacity: 1,
                  stroke: "#edf0f5",
                  strokeWidth: 1.5,
                  pointerEvents: "none",
                }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {keys.map((key) => (
              <Line
                key={`${key}-trend`}
                dataKey={`${key}Trend`}
                type="linear"
                stroke={FOOT_COLORS[key]}
                strokeWidth={2}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
});

export const PacePlot = memo(function PacePlot({
  rows,
  totalKm,
  stage,
  rangeLabel,
}) {
  const domain = useMemo(() => axisBounds(rows, ["pace"]), [rows]);
  const center =
    totalKm > 0 ? ((stage.start + stage.end) / 2 / totalKm) * 100 : 50;
  return (
    <div className="studio-pace-plot" aria-label="本次跑步配速与估算公里位置">
      {rows.length > 0 && !stage.fullRange && (
        <div className="pace-selection" aria-hidden="true">
          <span
            style={{
              left: `${(stage.start / totalKm) * 100}%`,
              width: `${((stage.end - stage.start) / totalKm) * 100}%`,
            }}
          />
        </div>
      )}
      {!rows.length ? (
        <p className="chart-empty">暂无公里数据</p>
      ) : (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart
            data={rows}
            margin={{ top: 4, right: 5, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke="#2b2f34" vertical={false} />
            <XAxis
              dataKey="distance"
              type="number"
              domain={[0, totalKm]}
              ticks={[0, totalKm]}
              tickFormatter={(value) => valueText(value, 2)}
              tick={{ fill: "#969eaa", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={domain}
              reversed
              width={38}
              tickCount={3}
              tickFormatter={paceText}
              tick={{ fill: "#969eaa", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
            />
            <Line
              dataKey="pace"
              stroke="#a7b4c7"
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Tooltip
              labelFormatter={(value) => `≈ ${valueText(value, 2)} km`}
              formatter={(value) => [paceText(value), "配速 / km"]}
              contentStyle={{
                background: "#23272d",
                border: "1px solid #424a55",
                borderRadius: 4,
                fontSize: 12,
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      {rows.length > 0 && (
        <div className="pace-range-axis">
          <span
            data-testid="stage-label"
            style={{ left: `clamp(84px, ${center}%, calc(100% - 84px))` }}
          >
            {rangeLabel}
          </span>
        </div>
      )}
    </div>
  );
});
