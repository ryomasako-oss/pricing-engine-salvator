/* A page's data did not load (docs/ui-standar.md, Empty / Loading / Error):
   say what happened and offer one retry, instead of an empty page and a toast. */

export function LoadError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="card-body empty" role="alert">
      <h3>Gagal memuat data</h3>
      <p>{message || "Server tidak menjawab."} Data Anda aman; coba lagi sebentar.</p>
      <button className="btn primary" onClick={onRetry}>Coba lagi</button>
    </div>
  );
}
