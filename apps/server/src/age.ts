/** Minimum age to use Redline (docs/COMPLIANCE.md; the threshold may rise per the lawyer's review). */
export const MIN_AGE = 13;

/**
 * Compares a date of birth ("YYYY-MM-DD") with today's UTC date. "invalid" for a malformed,
 * impossible, future or pre-1900 date. The date itself is never stored.
 */
export function checkAge(dateOfBirth: unknown, today: Date): "ok" | "blocked" | "invalid" {
  if (typeof dateOfBirth !== "string") return "invalid";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return "invalid";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const born = new Date(Date.UTC(y, mo - 1, d));
  if (born.getUTCFullYear() !== y || born.getUTCMonth() !== mo - 1 || born.getUTCDate() !== d) return "invalid";
  if (y < 1900 || born.getTime() > today.getTime()) return "invalid";
  const ty = today.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d);
  const age = ty - y - (beforeBirthday ? 1 : 0);
  return age >= MIN_AGE ? "ok" : "blocked";
}
