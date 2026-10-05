/**
 * 零依賴系統指標（C4）：counter 為主，供 /metrics 以 Prometheus 文字格式輸出。
 * 另有 Grafana 範本見 docs/grafana-dashboard.json。
 */
export type MetricLabels = Record<string, string>;

const counters = new Map<string, { name: string; labels: MetricLabels; value: number }>();

function keyOf(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(",")}}`;
}

export function recordMetric(name: string, value: number, labels: MetricLabels = {}): void {
  const key = keyOf(name, labels);
  const existing = counters.get(key);
  if (existing) existing.value += value;
  else counters.set(key, { name, labels: { ...labels }, value });
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** 取出計數器快照（K5 用量儀表板用）。 */
export function getCounters(): Array<{ name: string; labels: MetricLabels; value: number }> {
  return [...counters.values()].map((c) => ({ name: c.name, labels: { ...c.labels }, value: c.value }));
}

/** Prometheus exposition 文字格式。 */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const { name, labels, value } of counters.values()) {
    const labelStr = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${escapeLabel(labels[k])}"`)
      .join(",");
    lines.push(`${name}{${labelStr}} ${value}`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "# no metrics yet\n";
}
