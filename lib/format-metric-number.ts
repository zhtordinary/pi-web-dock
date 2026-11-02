export function formatMetricNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n) || n === 0) return "0";

  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000_000) {
    const value = abs / 1_000_000_000;
    return `${sign}${(value >= 10 ? value.toFixed(1) : value.toFixed(2)).replace(/\.?0+$/, "")}B`;
  }
  if (abs >= 1_000_000) {
    const value = abs / 1_000_000;
    return `${sign}${(value >= 10 ? value.toFixed(1) : value.toFixed(2)).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) {
    const value = abs / 1_000;
    return `${sign}${value.toFixed(1).replace(/\.?0+$/, "")}K`;
  }
  return `${sign}${abs.toLocaleString(locale)}`;
}
