/**
 * The small part of the Prometheus text format this API needs: one histogram kept in memory
 * and gauges read at scrape time. Written out rather than pulled from prom-client to keep the
 * lockfile unchanged; the output follows https://prometheus.io/docs/instrumenting/exposition_formats/.
 */

export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export function formatLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

interface Series {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram {
  private readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[] = LATENCY_BUCKETS,
  ) {}

  observe(labels: Labels, seconds: number): void {
    const key = formatLabels(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((le, i) => {
      if (seconds <= le) s.counts[i] += 1;
    });
    s.sum += seconds;
    s.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      this.buckets.forEach((le, i) => {
        lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le: String(le) })} ${s.counts[i]}`);
      });
      lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export function renderGauge(name: string, help: string, samples: { labels?: Labels; value: number }[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const s of samples) lines.push(`${name}${formatLabels(s.labels ?? {})} ${s.value}`);
  return lines.join('\n');
}
