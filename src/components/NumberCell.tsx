/* A numeric table cell that lets you clear it and type from scratch.

   A plain controlled <input type="number" value={n}> snaps back the moment the
   value stops being a usable number: delete a price and the computed default
   reappears under the cursor, so you can never type a new one. Here the text
   being typed is kept locally while the cell has focus; the parent only sees
   the number. With `live` it hears every keystroke (qty, cost); without it,
   only on blur/Enter (prices, where each change re-prices the quote), and
   Escape drops the edit. */

import { useRef, useState } from "react";

interface Props {
  value: number;
  /** Called with 0 when the cell is empty. */
  onCommit: (v: number) => void;
  live?: boolean;
  /** Text shown while not focused; defaults to the number itself. */
  display?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
}

const toNumber = (s: string) => {
  const n = Number(s);
  return s.trim() === "" || !Number.isFinite(n) ? 0 : Math.max(0, n);
};

export function NumberCell({ value, onCommit, live, display, className, disabled, title, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const cancelled = useRef(false);
  /** The text the cell showed when it got focus; leaving without changing it is not an edit. */
  const opened = useRef("");

  const commit = () => {
    if (draft !== null && !cancelled.current && draft !== opened.current) onCommit(toNumber(draft));
    cancelled.current = false;
    setDraft(null);
  };

  return (
    <input
      className={className}
      type="number"
      min="0"
      inputMode="decimal"
      disabled={disabled}
      title={title}
      aria-label={rest["aria-label"]}
      value={editing ? draft : (display ?? String(value))}
      onFocus={(e) => {
        opened.current = display ?? String(value);
        setDraft(opened.current);
        e.target.select();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        if (live) onCommit(toNumber(e.target.value));
      }}
      onBlur={() => (live ? setDraft(null) : commit())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape" && !live) {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
