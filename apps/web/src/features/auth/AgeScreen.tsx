import { useState, type FormEvent } from "react";
import { api, ApiFailure } from "../../lib/api";
import { Button } from "../../ui/Button";
import { writeAge } from "./age";
import s from "./Auth.module.css";

/** Neutral date of birth screen: no hint about the cutoff. The server decides and keeps only the result. */
export function AgeScreen({ onResult }: { onResult: (r: "ok" | "under") => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const dob = new Date(`${value}T00:00:00`);
    if (!value || Number.isNaN(dob.getTime()) || dob > new Date()) return setErr("Enter your date of birth as day, month and year.");
    setBusy(true);
    setErr(null);
    try {
      // sets the server's signed age cookie, which sign-in requires
      await api("/age-check", { method: "POST", json: { dateOfBirth: value } });
      writeAge("ok");
      onResult("ok");
    } catch (e) {
      if (e instanceof ApiFailure && e.body?.error.code === "age_blocked") {
        writeAge("under");
        onResult("under");
      } else {
        setErr(e instanceof Error ? e.message : "Could not check your date of birth. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={s.panel} onSubmit={submit} noValidate>
      <p className={`${s.kicker} mono`}>Step 1 of 2</p>
      <h1 className={`${s.title} display`}>Your date of birth</h1>
      <label className={s.field}>
        <span>Date of birth</span>
        <input type="date" value={value} onChange={(e) => setValue(e.target.value)} max={new Date().toISOString().slice(0, 10)} required />
      </label>
      {err && <p className={s.err} role="alert">{err}</p>}
      <Button type="submit" disabled={busy}>{busy ? "Checking" : "Continue"}</Button>
    </form>
  );
}
