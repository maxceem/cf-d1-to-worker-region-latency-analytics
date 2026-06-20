"use strict";

const METRICS = [
  { key: "p50", label: "p50" },
  { key: "p90", label: "p90" },
  { key: "p95", label: "p95" },
  { key: "p99", label: "p99" },
  { key: "min", label: "Min" },
  { key: "avg", label: "Avg" },
  { key: "max", label: "Max" },
];
const METRIC_KEYS = METRICS.map((metric) => metric.key);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

function finiteValues(values) {
  return values.filter(isFiniteNumber);
}

function sortedValues(values) {
  return finiteValues(values).sort((a, b) => a - b);
}

function percentile(values, p) {
  const sorted = sortedValues(values);
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function average(values) {
  const valid = finiteValues(values);
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function stddev(values) {
  const valid = finiteValues(values);
  if (valid.length < 2) return 0;
  const avg = average(valid);
  const variance = valid.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (valid.length - 1);
  return Math.sqrt(variance);
}

function min(values) {
  const valid = finiteValues(values);
  return valid.length ? Math.min(...valid) : null;
}

function max(values) {
  const valid = finiteValues(values);
  return valid.length ? Math.max(...valid) : null;
}

function reduceMetric(values, metricKey) {
  if (metricKey === "avg") return average(values);
  if (metricKey === "p50") return percentile(values, 50);
  if (metricKey === "p90") return percentile(values, 90);
  if (metricKey === "p95") return percentile(values, 95);
  if (metricKey === "p99") return percentile(values, 99);
  if (metricKey === "min") return min(values);
  if (metricKey === "max") return max(values);
  return null;
}

function metricStats(values) {
  const stats = {};
  for (const key of METRIC_KEYS) stats[key] = reduceMetric(values, key);
  stats.stddev = stddev(values);
  return stats;
}

function twoStepMetricStats(groups) {
  const stats = {};
  let avgRequestValues = [];
  for (const key of METRIC_KEYS) {
    const requestValues = groups
      .map((values) => reduceMetric(values, key))
      .filter(isFiniteNumber);
    stats[key] = reduceMetric(requestValues, key);
    if (key === "avg") avgRequestValues = requestValues;
  }
  stats.stddev = stddev(avgRequestValues);
  return stats;
}

function emptyMetricStats() {
  return { avg: null, p50: null, p90: null, p95: null, p99: null, min: null, max: null, stddev: null };
}

module.exports = {
  METRICS,
  METRIC_KEYS,
  average,
  emptyMetricStats,
  finiteValues,
  isFiniteNumber,
  max,
  metricStats,
  min,
  numberOrNull,
  percentile,
  reduceMetric,
  sortedValues,
  stddev,
  twoStepMetricStats,
};
