/* /api/familiarity: the workbench's whole contract with the server, in one place.
   The shapes are the server's own (shared/familiarity.ts, server/familiarity.ts).

   POST  /familiarity/feed                       { client_id, title, raw_lines } -> session view
   PATCH /familiarity/sessions/:id/resolve       { row_id, action, item_id?, new_item_payload?,
                                                   apply_to_client_only } -> the rows it settled

   A feed never creates a quotation. A resolve stores a rule for the row's
   wording; every row of the session with the same wording follows it, and the
   response carries all of them.

   Where a rule applies (server/familiarity.ts resolveFamiliarityRow):
   - with a client, apply_to_client_only (the default) = that client, every later list;
   - false = every client; only a manager (edit_catalog) may store that;
   - no client and apply_to_client_only = this session only: nothing carries over.

   The server's refusals are already sentences for the person (FamiliarityError). */

import { api } from "./api";
import type { FamiliarityAction, FamiliaritySessionView } from "@shared/familiarity";

export interface FeedLine {
  text: string;
  qty?: number;
  unit?: string;
  code?: string;
}

export interface FeedRequest {
  client_id: number | null;
  title: string;
  raw_lines: FeedLine[];
}

/** A barang baru to request, or an already-requested one to point at (matched by code, then name). */
export interface NewItemPayload {
  name: string;
  uom: string;
  code?: string;
}

export interface ResolveRequest {
  row_id: number;
  action: FamiliarityAction;
  /** Catalog id for verify_item; for reject_candidate a catalog id or "pending:<id>". */
  item_id?: string;
  new_item_payload?: NewItemPayload;
  apply_to_client_only: boolean;
}

export const familiarityApi = {
  feed: (body: FeedRequest) => api.post<FamiliaritySessionView>("/familiarity/feed", body),
  resolve: (sessionId: number, body: ResolveRequest) =>
    api.patch<FamiliaritySessionView>(`/familiarity/sessions/${sessionId}/resolve`, body),
};
