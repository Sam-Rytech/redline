import { useState, type FormEvent } from "react";
import { Button } from "../../ui/Button";
import { isOldEnough, writeAge } from "./age";
import s from "./Auth.module.css";

/** Neutral date of birth screen: no hint about the cutoff. Only the result is kept. */
export function AgeScreen({ onResult }: { onResult: (r: "ok" | "under") => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const dob = new Date(`${value}T00:00:00`);
    if (!value || Number.isNaN(dob.getTime()) || dob > new Date()) return setErr("Enter your date of birth as day, month and year.");
    const result = isOldEnough(dob) ? "ok" : "under";
    writeAge(result);
    onResult(result);
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
      <Button type="submit">Continue</Button>
    </form>
  );
}
