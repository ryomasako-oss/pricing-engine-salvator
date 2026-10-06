/* A line that says what the system is doing while a slow step runs (AI reading
   a PDF can take up to a minute). The lines advance and a counter shows how
   long it has been, so a long wait reads as work in progress instead of a
   hang. Pass only lines that are true of the step being waited on. */

import { useEffect, useState } from "react";

export function WaitingLine({ lines, every = 2800 }: { lines: string[]; every?: number }) {
  const [tick, setTick] = useState(0);
  const key = lines.join("\n");

  // A new step (different lines) starts again from its first line.
  useEffect(() => {
    setTick(0);
  }, [key]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Steps are told once, in order, and the last line stays: starting over would claim the work restarted.
  const index = Math.min(Math.floor((tick * 1000) / every), lines.length - 1);
  return (
    <div className="waiting" role="status" aria-live="polite">
      <span className="dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="wl-text" key={index}>{lines[index]}</span>
      <span className="wl-sec">{tick} dtk</span>
    </div>
  );
}
