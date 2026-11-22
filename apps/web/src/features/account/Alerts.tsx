import type { TelegramLinkResponse, Watch, WatchRules } from "@redline/api-types";
import { useState } from "react";
import { api } from "../../lib/api";
import { shortId } from "../../lib/format";
import { useApi } from "../../lib/useApi";
import { useMe } from "../../lib/useMe";
import { Button, ButtonLink } from "../../ui/Button";
import { SignInPrompt } from "./SignInPrompt";
import { Reveal } from "../../ui/Reveal";
import s from "./Account.module.css";

export function Alerts() {
  const { me, signedOut } = useMe();
  const watches = useApi<Watch[]>(me ? "/watches" : null);
  const [link, setLink] = useState<TelegramLinkResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const connect = async () => {
    setErr(null);
    try {
      setLink(await api<TelegramLinkResponse>("/telegram/link-token", { method: "POST" }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Optimistic rule change: flip now, put it back if the server refuses.
  const setRule = async (w: Watch, key: keyof WatchRules, value: boolean) => {
    const before = watches.data ?? [];
    watches.setData(before.map((x) => (x.id === w.id ? { ...x, rules: { ...x.rules, [key]: value } } : x)));
    try {
      await api<Watch>(`/watches/${w.id}`, { method: "PATCH", json: { rules: { [key]: value } } });
    } catch {
      watches.setData(before);
      setErr("That change did not save. Try again.");
    }
  };

  return (
    <main className={s.page}>
      <Reveal as="h1" className={`${s.h1} display`}>Alerts</Reveal>
      {signedOut && <SignInPrompt what="get alerts in Telegram" />}
      {me && (
        <>
          <Reveal from="left" delay={0.1}>
          <section className={s.block}>
            <h2 className={s.h2}>Telegram</h2>
            {me.telegramLinked ? (
              <p className={s.body}>Connected. Alerts go to your Telegram chat with the Redline bot.</p>
            ) : link ? (
              <>
                <p className={s.body}>Open the Redline bot and press Start. The link works until {new Date(link.expiresAt).toLocaleTimeString()}.</p>
                <a className={s.ext} href={link.url} target="_blank" rel="noreferrer">Open the Redline bot</a>
              </>
            ) : (
              <>
                <p className={s.body}>Alerts arrive as Telegram messages. Connect once; it takes one tap in Telegram.</p>
                <Button onClick={connect}>Connect Telegram</Button>
              </>
            )}
          </section>
          </Reveal>
          <Reveal from="right" delay={0.2}>
          <section className={s.block}>
            <h2 className={s.h2}>Watched loans</h2>
            <p className={s.body}>Liquidation alerts come at 25%, 15% and 8% from the line. Loan-gone alerts come when a loan closes or is liquidated.</p>
            {watches.data?.length === 0 && (
              <div className={s.prompt}>
                <p>No loans watched yet. Open any loan and press Watch this loan.</p>
                <ButtonLink to="/loans" variant="quiet">See every loan</ButtonLink>
              </div>
            )}
            <ul className={s.watches}>
              {watches.data?.map((w) => (
                <li key={w.id} className={s.watchRow}>
                  <span className="mono">{shortId(w.loanId)}</span>
                  <Toggle label="Liquidation" on={w.rules.liquidation} onChange={(v) => setRule(w, "liquidation", v)} />
                  <Toggle label="Loan gone" on={w.rules.loanGone} onChange={(v) => setRule(w, "loanGone", v)} disabled={!me.pro} />
                </li>
              ))}
            </ul>
            {!me.pro && <p className={s.small}>Loan-gone alerts and more than one watch come with the Pro pass.</p>}
          </section>
          </Reveal>
          {err && <p className={s.err} role="alert">{err}</p>}
        </>
      )}
    </main>
  );
}

function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={s.toggle}>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
