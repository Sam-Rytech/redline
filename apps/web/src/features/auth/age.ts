// The server keeps the real age result in its own signed, httpOnly cookie `rl_age` (set by
// POST /api/age-check). This browser-readable cookie only remembers that the screen was passed,
// so it has its own name and never shadows the server's.
const COOKIE = "rl_age_seen";
export const AGE_CUTOFF = 13;

export type AgeResult = "ok" | "under" | null;

export function readAge(): AgeResult {
  const m = document.cookie.match(/(?:^|; )rl_age_seen=(ok|under)/);
  return (m?.[1] as AgeResult) ?? null;
}

/** Stores only the result, never the date. A failed check sticks for a year. */
export function writeAge(result: "ok" | "under") {
  document.cookie = `${COOKIE}=${result}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax`;
}

/** Forget the remembered result, e.g. when the server says the age check is missing. */
export function clearAge() {
  document.cookie = `${COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

export function isOldEnough(dob: Date, now = new Date()): boolean {
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age >= AGE_CUTOFF;
}
