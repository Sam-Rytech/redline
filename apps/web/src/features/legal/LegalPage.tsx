import { useParams } from "react-router";
import { NotFound } from "../../app/NotFound";
import { LEGAL } from "./docs";
import s from "./Legal.module.css";

export function LegalPage() {
  const { doc = "" } = useParams();
  const d = LEGAL[doc];
  if (!d) return <NotFound />;
  return (
    <main className={s.page}>
      <h1 className={`${s.h1} display`}>{d.title}</h1>
      <p className="mono">Updated {d.updated}</p>
      {d.sections.map((sec) => (
        <section key={sec.h} className={s.sec}>
          <h2 className={s.h2}>{sec.h}</h2>
          {sec.p.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
        </section>
      ))}
    </main>
  );
}
