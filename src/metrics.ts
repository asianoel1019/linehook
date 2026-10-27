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

/** Prometheus exposition 文字格式（counter＋histogram 同一個端點）。 */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const { name, labels, value } of counters.values()) {
    const labelStr = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${escapeLabel(labels[k])}"`)
      .join(",");
    lines.push(`${name}{${labelStr}} ${value}`);
  }
  for (const h of histograms.values()) {
    const base = Object.keys(h.labels)
      .sort()
      .map((k) => `${k}="${escapeLabel(h.labels[k])}"`)
      .join(",");
    const prefix = base ? `${h.name}{${base},` : `${h.name}{`;
    h.buckets.forEach((le, i) => {
      lines.push(`${prefix}le="${le}"} ${h.counts[i]}`);
    });
    lines.push(`${prefix}le="+Inf"} ${h.count}`);
    lines.push(`${h.name}_sum{${base}} ${h.sum}`);
    lines.push(`${h.name}_count{${base}} ${h.count}`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "# no metrics yet\n";
}

/* ── P0-1 耗時 histogram（零依賴手刻，Prometheus 經典三件套） ── */

export const DURATION_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60];

interface Histogram {
  name: string;
  labels: MetricLabels;
  buckets: number[];
  /** 累積計數（counts[i] = ≤ buckets[i] 的樣本數，Prometheus 語意）。 */
  counts: number[];
  sum: number;
  count: number;
}

const histograms = new Map<string, Histogram>();

/** 記一筆耗時（秒）。labels 相同但 buckets 不同視為不同序列（呼叫端固定用預設即可）。 */
export function recordDuration(
  name: string,
  seconds: number,
  labels: MetricLabels = {},
  buckets: number[] = DURATION_BUCKETS,
): void {
  const key = `${keyOf(name, labels)}#${buckets.join(",")}`;
  let h = histograms.get(key);
  if (!h) {
    h = { name, labels: { ...labels }, buckets: [...buckets], counts: buckets.map(() => 0), sum: 0, count: 0 };
    histograms.set(key, h);
  }
  const s = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  for (let i = 0; i < h.buckets.length; i++) {
    if (s <= (h.buckets[i] as number)) (h.counts[i] as number) += 1;
  }
  h.sum += s;
  h.count += 1;
}

/** 技能錯誤分類（給 skill_errors_total{skill,class} 用；按訊息特徵歸類，未知進 other）。 */
export function classifySkillError(message: string): string {
  if (/abort|aborterror|timeout|timed out|超時|逾時/i.test(message)) return "timeout";
  if (/http\s*5\d\d/i.test(message)) return "http5xx";
  if (/http\s*[45]\d\d/i.test(message)) return "http4xx";
  if (/blockedhost|內網|metadata|ssrf/i.test(message)) return "blocked";
  if (/enotfound|eai_again|econn|fetch failed|network|dns|解析失敗/i.test(message)) return "network";
  if (/\bjson\b|parse|語法|syntax/i.test(message)) return "parse";
  if (/api[^a-z]*key|token|未設定|缺少|unauthorized|\b401\b/i.test(message)) return "config";
  return "other";
}
