/* Pratinjau gambar barang di halaman yang sama: roda mouse / tombol +/− untuk zoom, seret untuk
   menggeser, klik dua kali untuk zoom cepat, Esc atau klik area gelap untuk menutup. Gambar kecil
   otomatis diperbesar sampai memenuhi layar (maksimal MAX_FIT_UPSCALE× ukuran asli). */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

interface Props {
  src: string;
  alt: string;
  /** Dipakai kalau `src` gagal dimuat (mis. gambar penuh belum ada di Hub). */
  fallbackSrc?: string;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const BUTTON_STEP = 1.5;
const DOUBLE_CLICK_SCALE = 2.5;
const MAX_FIT_UPSCALE = 4;

interface View {
  scale: number;
  x: number;
  y: number;
}

const RESET_VIEW: View = { scale: MIN_SCALE, x: 0, y: 0 };

export function ImageLightbox({ src, alt, fallbackSrc, onClose }: Props) {
  const [view, setView] = useState<View>(RESET_VIEW);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
    onBackdrop: boolean;
  } | null>(null);

  // Titik (px, py) relatif ke pusat panggung tetap berada di bawah kursor saat zoom.
  const zoomTo = useCallback((nextScale: number, px = 0, py = 0) => {
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
      if (scale === MIN_SCALE) return RESET_VIEW;
      const ratio = scale / current.scale;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, []);

  // Fase capture + stopPropagation: Esc hanya menutup pratinjau, bukan dialog (Modal) di bawahnya.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (event.key === "+" || event.key === "=") zoomTo(view.scale * BUTTON_STEP);
      else if (event.key === "-") zoomTo(view.scale / BUTTON_STEP);
      else if (event.key === "0") setView(RESET_VIEW);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, zoomTo, view.scale]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // contentRect tidak menghitung padding, jadi ini persis area yang tersedia untuk gambar.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStageSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Harus non-passive supaya preventDefault menahan scroll halaman di belakang.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const rect = stage!.getBoundingClientRect();
      const px = event.clientX - (rect.left + rect.width / 2);
      const py = event.clientY - (rect.top + rect.height / 2);
      zoomTo(view.scale * Math.exp(-event.deltaY * 0.0015), px, py);
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomTo, view.scale]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
      moved: false,
      onBackdrop: event.target === event.currentTarget,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || view.scale === MIN_SCALE) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView((current) => ({ ...current, x: d.originX + dx, y: d.originY + dy }));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    // Klik di latar (bukan di gambar, bukan seretan) menutup pratinjau.
    if (!d.moved && d.onBackdrop) onClose();
  }

  // Pointer capture mengalihkan dblclick ke panggung, jadi handler dipasang di sini, bukan di <img>.
  function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (view.scale > MIN_SCALE) {
      setView(RESET_VIEW);
      return;
    }
    zoomTo(DOUBLE_CLICK_SCALE, event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
  }

  const shownSrc = failed && fallbackSrc ? fallbackSrc : src;
  const fitScale = natural && stageSize ? Math.min(stageSize.w / natural.w, stageSize.h / natural.h, MAX_FIT_UPSCALE) : null;
  const fitStyle = natural && fitScale ? { width: natural.w * fitScale, height: natural.h * fitScale } : {};

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="lightbox-toolbar">
        <button type="button" className="lightbox-btn" onClick={() => zoomTo(view.scale / BUTTON_STEP)} aria-label="Perkecil" title="Perkecil (−)">
          −
        </button>
        <button type="button" className="lightbox-btn lightbox-percent" onClick={() => setView(RESET_VIEW)} title="Pas layar (0)">
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" className="lightbox-btn" onClick={() => zoomTo(view.scale * BUTTON_STEP)} aria-label="Perbesar" title="Perbesar (+)">
          +
        </button>
        <button type="button" className="lightbox-btn" onClick={onClose} aria-label="Tutup" title="Tutup (Esc)">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div
        ref={stageRef}
        className={`lightbox-stage${view.scale > MIN_SCALE ? " is-zoomed" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <img
          key={shownSrc}
          src={shownSrc}
          alt={alt}
          className="lightbox-image"
          draggable={false}
          style={{ ...fitStyle, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          onLoad={(event) => setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
      </div>
      <div className="lightbox-caption">{alt}</div>
    </div>,
    document.body,
  );
}
