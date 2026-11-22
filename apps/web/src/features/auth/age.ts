const COOKIE = "rl_age";
export const AGE_CUTOFF = 13;

export type AgeResult = "ok" | "under" | null;

export function readAge(): AgeResult {
  const m = document.cookie.match(/(?:^|; )rl_age=(ok|under)/);
  return (m?.[1] as AgeResult) ?? null;
}

/** Stores only the result, never the date. A failed check sticks for a year. */
export function writeAge(result: "ok" | "under") {
  document.cookie = `${COOKIE}=${result}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax`;
}

export function isOldEnough(dob: Date, now = new Date()): boolean {
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age >= AGE_CUTOFF;
}
