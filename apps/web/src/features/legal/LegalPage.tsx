import { useParams } from "react-router";
import { NotFound } from "../../app/NotFound";
import { LEGAL } from "./docs";
import { Reveal } from "../../ui/Reveal";
import s from "./Legal.module.css";

export function LegalPage() {
  const { doc = "" } = useParams();
  const d = LEGAL[doc];
  if (!d) return <NotFound />;
  return (
    <main className={s.page}>
      <Reveal as="h1" className={`${s.h1} display`}>{d.title}</Reveal>
      <Reveal as="p" delay={0.1} className="mono">Updated {d.updated}</Reveal>
      {d.sections.map((sec, i) => (
        <Reveal as="section" key={sec.h} delay={i < 3 ? 0.15 + i * 0.07 : 0} className={s.sec}>
          <h2 className={s.h2}>{sec.h}</h2>
          {sec.p.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
        </Reveal>
      ))}
    </main>
  );
}
