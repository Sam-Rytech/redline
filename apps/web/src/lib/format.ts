const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const fmtUsd = (n: number) => usd.format(n);
export const fmtInt = (n: number) => int.format(n);
export const fmtBch = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} BCH`;
export const fmtPusd = (n: number) => `${int.format(n)} PUSD`;
export const fmtPct = (n: number | null, digits = 1) => (n === null ? "No debt" : `${n.toFixed(digits)}%`);
export const fmtDistance = (d: number | null) => (d === null ? "No debt" : `${Math.round(d * 100)}% from liquidation`);
export const shortId = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;
