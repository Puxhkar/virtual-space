/**
 * Metrics.
 *
 * Counters and gauges in memory, exposed as JSON. Deliberately not Prometheus:
 * one process serving ten people does not need a scrape protocol, a time
 * series database, or a query language (CLAUDE.md §7). What it needs is an
 * answer to "is anything broken right now", and this gives that.
 *
 * The shape is Prometheus-compatible enough that swapping in a real exporter
 * later is a rewrite of this file and nothing else.
 */

const counters = new Map<string, number>();
const gauges = new Map<string, () => number>();

/** Latency samples, kept bounded — this is not a time series database. */
const MAX_SAMPLES = 512;
const samples = new Map<string, number[]>();

export function increment(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/** Registers a value read on demand, e.g. the size of the presence store. */
export function gauge(name: string, read: () => number): void {
  gauges.set(name, read);
}

export function observe(name: string, value: number): void {
  let bucket = samples.get(name);
  if (!bucket) {
    bucket = [];
    samples.set(name, bucket);
  }
  bucket.push(value);
  // Drop the oldest half rather than one at a time, so this is amortised.
  if (bucket.length > MAX_SAMPLES) bucket.splice(0, MAX_SAMPLES / 2);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  latency: Record<
    string,
    { count: number; p50: number; p95: number; p99: number }
  >;
  uptimeSeconds: number;
  memoryMb: number;
}

export function snapshot(): MetricsSnapshot {
  const latency: MetricsSnapshot["latency"] = {};
  for (const [name, values] of samples) {
    const sorted = [...values].sort((a, b) => a - b);
    latency[name] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }

  const gaugeValues: Record<string, number> = {};
  for (const [name, read] of gauges) {
    try {
      gaugeValues[name] = read();
    } catch {
      // A broken gauge must not take the metrics endpoint down with it —
      // that is the one endpoint you need when things are going wrong.
      gaugeValues[name] = -1;
    }
  }

  return {
    counters: Object.fromEntries(counters),
    gauges: gaugeValues,
    latency,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
}

/** Test seam. */
export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
  samples.clear();
}
