/* The preparer's signature for the customer letter. The server returns an
   image only for a final quote, so a draft never prints one (2026-11-19). */
import { useEffect, useState } from "react";
import { api } from "../api";
import { isDraftDoc } from "@shared/docColumns";
import type { QuoteStatus } from "@shared/types";
import type { DocSignature } from "../components/QuotationDoc";

export function useDocSignature(quoteId: number | undefined, status: QuoteStatus | undefined): DocSignature | null {
  const [signature, setSignature] = useState<DocSignature | null>(null);
  const final = status !== undefined && !isDraftDoc(status);
  useEffect(() => {
    setSignature(null);
    if (!quoteId || !final) return;
    let live = true;
    api
      .get<{ name: string; signature: string }>(`/quotes/${quoteId}/signature`)
      .then((r) => { if (live && r.signature) setSignature({ name: r.name, image: r.signature }); })
      .catch(() => undefined); // No signature is a blank signing space, as before.
    return () => { live = false; };
  }, [quoteId, final]);
  return signature;
}
