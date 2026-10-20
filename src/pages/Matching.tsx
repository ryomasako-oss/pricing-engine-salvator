/* Pencocokan: match a client's list to the catalog and teach the matcher their
   wording, without going through a quotation. What is settled here is used by
   Quotation → Dari list klien for that client's next list (server/catalogMatch.ts).
   Managers also see how well the matcher is doing. */

import { useAuth } from "../context/AuthContext";
import { FamiliarityWorkbench } from "../components/FamiliarityWorkbench";
import { MatchLearningPanel } from "../components/MatchLearningPanel";

export function MatchingPage() {
  const { can } = useAuth();
  return (
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <h1>Pencocokan barang</h1>
          <p>
            Cocokkan daftar barang klien ke katalog tanpa membuat quotation. Setiap baris yang Anda bereskan diingat, jadi list
            berikutnya dari klien itu, termasuk lewat Quotation → Dari list klien, langsung cocok.
          </p>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <FamiliarityWorkbench />
        </div>
      </div>
      {can("import_catalog") && <MatchLearningPanel />}
    </main>
  );
}
