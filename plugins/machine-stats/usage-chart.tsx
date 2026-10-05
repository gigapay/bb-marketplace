// One-series line chart for the Usage tab: a percent over the last few
// minutes, on a fixed 0-100 scale so CPU and RAM read the same way.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { HistoryPoint } from "./server";

const HEIGHT = 36;
// Room for the 4px end dot and its ring at the top and right edges.
const PAD = 5;

type Metric = "cpuPercent" | "memoryPercent";

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function UsageChart({
  label,
  metric,
  points,
  windowMs,
  intervalMs,
  now,
}: {
  label: string;
  metric: Metric;
  points: HistoryPoint[];
  windowMs: number;
  intervalMs: number;
  now: number;
}) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<HistoryPoint | null>(null);
  const plotWidth = Math.max(0, width - PAD);
  const start = now - windowMs;
  const x = (at: number) => Math.max(0, ((at - start) / windowMs) * plotWidth);
  const y = (value: number) => PAD + (1 - Math.min(100, Math.max(0, value)) / 100) * (HEIGHT - PAD - 1);

  // Break the line where samples are missing (machine offline, nobody watching).
  const runs: HistoryPoint[][] = [];
  for (const point of points) {
    if (point.at < start) continue;
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run === undefined || previous === undefined || point.at - previous.at > intervalMs * 3) {
      runs.push([point]);
    } else {
      run.push(point);
    }
  }
  const line = (run: HistoryPoint[]) =>
    run.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p[metric]).toFixed(1)}`).join("");
  const area = (run: HistoryPoint[]) => {
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined) return "";
    return `${line(run)}L${x(last.at).toFixed(1)},${HEIGHT - 1}L${x(first.at).toFixed(1)},${HEIGHT - 1}Z`;
  };

  const latest = points.at(-1);
  const shown = hover ?? latest;
  const values = points.filter((p) => p.at >= start).map((p) => p[metric]);
  const peak = values.length > 0 ? Math.max(...values) : null;

  // The crosshair snaps to the nearest sample, so the pointer only aims at a time.
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const at = start + ((event.clientX - bounds.left) / Math.max(1, plotWidth)) * windowMs;
    let nearest: HistoryPoint | null = null;
    for (const point of points) {
      if (point.at < start) continue;
      if (nearest === null || Math.abs(point.at - at) < Math.abs(nearest.at - at)) nearest = point;
    }
    setHover(nearest);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-1 text-2xs leading-4">
        <span className="text-subtle-foreground">{label}</span>
        <span className="min-w-0 flex-1 truncate text-right">
          {shown === undefined ? (
            <span className="text-muted-foreground">collecting…</span>
          ) : (
            <>
              <span className="font-medium text-sidebar-foreground tabular-nums">
                {Math.round(shown[metric])}%
              </span>
              <span className="text-subtle-foreground">
                {hover !== null
                  ? ` at ${formatTime(hover.at)}`
                  : peak !== null
                    ? ` · peak ${Math.round(peak)}%`
                    : ""}
              </span>
            </>
          )}
        </span>
      </div>
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={HEIGHT}
          className="block touch-none text-primary"
          role="img"
          aria-label={`${label} over the last ${Math.round(windowMs / 60_000)} minutes${
            latest !== undefined ? `, now ${Math.round(latest[metric])}%` : ""
          }${peak !== null ? `, peak ${Math.round(peak)}%` : ""}`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Recessive hairlines at 50% and the baseline. */}
          <line x1={0} x2={plotWidth} y1={y(50)} y2={y(50)} className="stroke-sidebar-border" strokeWidth={1} />
          <line x1={0} x2={plotWidth} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-sidebar-border" strokeWidth={1} />
          {runs.map((run) => (
            <g key={run[0]?.at}>
              <path d={area(run)} fill="currentColor" fillOpacity={0.1} />
              <path
                d={line(run)}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ))}
          {hover !== null ? (
            <line
              x1={x(hover.at)}
              x2={x(hover.at)}
              y1={0}
              y2={HEIGHT}
              className="stroke-subtle-foreground"
              strokeWidth={1}
            />
          ) : null}
          {shown !== undefined && shown.at >= start ? (
            <circle
              cx={x(shown.at)}
              cy={y(shown[metric])}
              r={4}
              fill="currentColor"
              className="stroke-sidebar"
              strokeWidth={2}
            />
          ) : null}
        </svg>
      </div>
    </div>
  );
}
