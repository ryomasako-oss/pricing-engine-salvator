import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/* A button that opens a short list of actions (docs/ui-standar.md, "Menu").
   Used where several related actions would otherwise crowd the page head,
   e.g. the catalog's import variants. Escape or a click outside closes it;
   arrow keys move between items. */

export type MenuEntry =
  | { label: string; icon?: string; hint?: string; danger?: boolean; onSelect: () => void }
  | "divider";

export function Menu({ label, icon, items }: { label: string; icon?: string; items: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const entries = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const list = entries();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
  };

  return (
    <div className="menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon && <Icon name={icon} size={15} />} {label} <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="menu-list" role="menu" aria-label={label}>
          {items.map((it, i) =>
            it === "divider" ? (
              <div key={i} className="menu-divider" role="separator" />
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={`menu-item${it.danger ? " danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={15} />}
                <span>
                  {it.label}
                  {it.hint && <small>{it.hint}</small>}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
