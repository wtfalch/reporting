'use client';

import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  type Beacon,
  type ConsentAnswer,
  type ConsentMode,
  createBeacon,
} from '../browser/index.js';

/**
 * The beacon for App Router apps: one provider in the root layout, a hook to
 * track, and a consent control the host places where its design says. The
 * provider never renders anything of its own; the consent control is plain
 * markup under class names the host styles (a `data-reporting-consent`
 * root, two buttons), because the package carries no design system.
 */

interface Ctx {
  readonly beacon: Beacon | null;
  readonly answer: ConsentAnswer;
  readonly mode: ConsentMode;
  accept(): void;
  decline(): void;
}

const ReportingContext = createContext<Ctx>({
  beacon: null,
  answer: null,
  mode: 'none',
  accept: () => undefined,
  decline: () => undefined,
});

export function ReportingProvider(props: {
  readonly collector: string;
  readonly site: string;
  readonly consent?: ConsentMode;
  readonly children: ReactNode;
}) {
  const [beacon, setBeacon] = useState<Beacon | null>(null);
  const [answer, setAnswer] = useState<ConsentAnswer>(null);
  const mode = props.consent ?? 'consented';
  useEffect(() => {
    const b = createBeacon({ collector: props.collector, site: props.site, consent: mode });
    setBeacon(b);
    setAnswer(b.answer());
    return () => b.destroy();
  }, [props.collector, props.site, mode]);
  const value = useMemo<Ctx>(
    () => ({
      beacon,
      answer,
      mode,
      accept() {
        beacon?.accept();
        setAnswer(beacon?.answer() ?? null);
      },
      decline() {
        beacon?.decline();
        setAnswer(beacon?.answer() ?? null);
      },
    }),
    [beacon, answer, mode],
  );
  return <ReportingContext.Provider value={value}>{props.children}</ReportingContext.Provider>;
}

/** `track(name, props)` from a client component; a no-op before the beacon mounts. */
export function useTrack(): (
  name: string,
  props?: Record<string, string | number | boolean | null>,
) => void {
  const { beacon } = useContext(ReportingContext);
  return (name, props) => beacon?.track(name, props);
}

/**
 * The consent question, shown only under `consented` and only until it is
 * answered. The host supplies the words; the control supplies the two
 * buttons and remembers the answer through the beacon's cookie.
 */
export function ConsentControl(props: {
  readonly children: ReactNode;
  readonly acceptLabel?: string;
  readonly declineLabel?: string;
  readonly className?: string;
}) {
  const { answer, mode, accept, decline, beacon } = useContext(ReportingContext);
  if (mode !== 'consented' || answer !== null || !beacon) return null;
  return (
    <section data-reporting-consent="" className={props.className} aria-label="Analytics consent">
      {props.children}
      <div data-reporting-consent-actions="">
        <button type="button" data-reporting-consent-decline="" onClick={decline}>
          {props.declineLabel ?? 'No thanks'}
        </button>
        <button type="button" data-reporting-consent-accept="" onClick={accept}>
          {props.acceptLabel ?? 'Allow'}
        </button>
      </div>
    </section>
  );
}
