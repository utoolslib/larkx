export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}
