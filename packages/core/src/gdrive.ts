/**
 * Google Docs / Drive adapter — pure mapping from Drive Activity API v2 activities to Retrace EventInputs.
 * Fed by the Apps Script forwarder (adapters/google-apps-script) or the retrace-gdrive CLI via POST /hooks/gdrive.
 *
 * Payload shape (what the forwarder sends):
 *   { project?: string, activities: DriveActivity[], actors?: { "people/123": { email?, name? } }, source?: "apps-script" | "cli",
 *     caused_by?: string }
 *
 * Mapping
 *   WHO   actor.user.knownUser.personName resolved through `actors` map (email preferred) — humans; anonymous/administrator/system → system;
 *         `impersonation` → the impersonated user; unknown → "google:people/…"
 *   WHAT  primaryActionDetail: create→created, edit→edited, delete→deleted, restore→other:restored, rename→renamed, move→moved,
 *         permissionChange→other:shared, comment→sent (post/reply/resolve), dlpChange/settingsChange/appliedLabelChange→other
 *         artifacts: gdoc:<fileId> (kind from mimeType) for each target; folders as gfolder:<id>
 *         role (PROV): create→generated, edit/rename/move→both, comment/permissionChange→used, everything else absent (driveRole)
 *   WHEN  timestamp or timeRange.endTime (edits are aggregated by Google into ranges; duration_ms = range length)
 *   WHERE system=google-drive, url=docs link
 *   WHY   free text summary (Drive Activity does not send body — Retrace never stores Doc bytes);
 *         caused_by from the payload when set (Apps Script RETRACE_CAUSED_BY / replay JSON); empty or absent → root
 *   HOW   tool=google-docs|sheets|slides|drive, manual
 */
import { EventInput, Actor, Action, ArtifactRole } from "./schema.js";

export interface DriveActorInfo { email?: string; name?: string }
export interface DrivePayload {
  project?: string;
  activities: any[];
  actors?: Record<string, DriveActorInfo>;
  source?: string;
  /** Optional causal parent (typically a retrace_instruct id). Empty/whitespace/absent → mapped events are roots. */
  caused_by?: string;
}

function causedByOf(payload: DrivePayload): string | undefined {
  if (typeof payload.caused_by !== "string") return undefined;
  const t = payload.caused_by.trim();
  return t || undefined;
}

const MIME: Record<string, { kind: string; tool: string; url: (id: string) => string }> = {
  "application/vnd.google-apps.document": { kind: "doc", tool: "google-docs", url: (id) => `https://docs.google.com/document/d/${id}/edit` },
  "application/vnd.google-apps.spreadsheet": { kind: "sheet", tool: "google-sheets", url: (id) => `https://docs.google.com/spreadsheets/d/${id}/edit` },
  "application/vnd.google-apps.presentation": { kind: "slides", tool: "google-slides", url: (id) => `https://docs.google.com/presentation/d/${id}/edit` },
  "application/vnd.google-apps.form": { kind: "form", tool: "google-forms", url: (id) => `https://docs.google.com/forms/d/${id}/edit` },
  "application/vnd.google-apps.folder": { kind: "folder", tool: "google-drive", url: (id) => `https://drive.google.com/drive/folders/${id}` },
};
const fileMeta = (mime?: string) => MIME[mime ?? ""] ?? { kind: "file", tool: "google-drive", url: (id: string) => `https://drive.google.com/file/d/${id}/view` };
const itemId = (name?: string) => (name ?? "").replace(/^items\//, "");

export function driveActor(a: any, actors: Record<string, DriveActorInfo> = {}): Actor {
  const u = a?.user ?? a?.impersonation?.impersonatedUser;
  if (u?.knownUser) {
    const pn: string = u.knownUser.personName ?? "";
    const info = actors[pn];
    const id = info?.email ?? `google:${pn}`;
    return { type: "human", id, display_name: info?.name ?? (info?.email ? undefined : pn) };
  }
  if (u?.deletedUser) return { type: "human", id: "google:deleted-user", display_name: "deleted user" };
  if (u?.unknownUser) return { type: "human", id: "google:unknown-user", display_name: "unknown user" };
  if (a?.anonymous) return { type: "human", id: "google:anonymous", display_name: "anonymous" };
  if (a?.administrator) return { type: "system", id: "google:administrator", display_name: "Workspace admin" };
  if (a?.system) return { type: "system", id: `google:${a.system.type ?? "system"}`.toLowerCase(), display_name: "Google Drive system" };
  return { type: "system", id: "google:drive" };
}

function detailToAction(d: any, actors: Record<string, DriveActorInfo> = {}): { action: Action; detail?: string; summary: string } {
  if (!d) return { action: "other", detail: "activity", summary: "activity" };
  if (d.create) { const c = d.create; return { action: "created", summary: c.copy ? `copied from ${itemId(c.copy.originalObject?.driveItem?.name)}` : c.upload ? "uploaded" : "created" }; }
  if (d.edit) return { action: "edited", summary: "edited" };
  if (d.delete) return { action: "deleted", summary: d.delete.type === "PERMANENT_DELETE" ? "permanently deleted" : "moved to trash" };
  if (d.restore) return { action: "other", detail: "restored", summary: "restored from trash" };
  if (d.rename) return { action: "renamed", detail: "renamed", summary: `renamed "${d.rename.oldTitle}" → "${d.rename.newTitle}"` };
  if (d.move) { const from = (d.move.removedParents ?? []).map((p: any) => itemId(p.driveItem?.name)).join(","); const to = (d.move.addedParents ?? []).map((p: any) => itemId(p.driveItem?.name)).join(","); return { action: "moved", summary: `moved${from ? " from " + from : ""}${to ? " to " + to : ""}` }; }
  if (d.permissionChange) { const pc = d.permissionChange; const added = (pc.addedPermissions ?? []).map((x: any) => permDesc(x, actors)), removed = (pc.removedPermissions ?? []).map((x: any) => permDesc(x, actors)); return { action: "other", detail: "shared", summary: [added.length ? "granted " + added.join(", ") : "", removed.length ? "revoked " + removed.join(", ") : ""].filter(Boolean).join("; ") || "permissions changed" }; }
  if (d.comment) { const c = d.comment; const kind = c.post ? `comment ${String(c.post.subtype ?? "added").toLowerCase().replace(/_/g, " ")}` : c.assignment ? `assignment ${String(c.assignment.subtype ?? "").toLowerCase().replace(/_/g, " ")}` : c.suggestion ? `suggestion ${String(c.suggestion.subtype ?? "").toLowerCase().replace(/_/g, " ")}` : "comment"; return { action: "sent", summary: kind }; }
  if (d.dlpChange) return { action: "other", detail: "dlp_change", summary: `DLP ${d.dlpChange.type}` };
  if (d.settingsChange) return { action: "other", detail: "settings_change", summary: "settings changed" };
  if (d.appliedLabelChange) return { action: "other", detail: "label_change", summary: "labels changed" };
  if (d.reference) return { action: "other", detail: "referenced", summary: "referenced from another app" };
  return { action: "other", detail: Object.keys(d)[0] ?? "activity", summary: Object.keys(d)[0] ?? "activity" };
}
/** PROV role of the targets, from what Drive authoritatively reports: create → generated; edit/rename/move → both (the
 *  file is read and rewritten); comment/permission change → used (acted on, content unchanged); delete/restore/dlp/
 *  settings/label/reference → absent (invalidation and administrative changes are not roles). */
function driveRole(d: any): ArtifactRole | undefined {
  if (!d) return undefined;
  if (d.create) return "generated";
  if (d.edit || d.rename || d.move) return "both";
  if (d.comment || d.permissionChange) return "used";
  return undefined;
}
function permDesc(p: any, actors: Record<string, DriveActorInfo> = {}): string {
  const pn = p.user?.knownUser?.personName;
  const who = pn ? (actors[pn]?.email ?? actors[pn]?.name ?? pn) : (p.anyone ? "anyone" : p.domain?.name ?? p.group?.email ?? "someone");
  return `${String(p.role ?? "").toLowerCase()} to ${who}`;
}

export function mapDriveActivities(payload: DrivePayload, defaultProject = "google-drive"): EventInput[] {
  const project = payload.project ?? defaultProject;
  const actors = payload.actors ?? {};
  const caused_by = causedByOf(payload);
  const out: EventInput[] = [];
  for (const act of payload.activities ?? []) {
    const targets = (act.targets ?? []).map((t: any) => t.driveItem ?? t.fileComment?.parent ?? t.drive?.root).filter(Boolean);
    // For renames the target title reflects query time, not event time — the new title is the as-at label
    const renamedTo = act.primaryActionDetail?.rename?.newTitle;
    const role = driveRole(act.primaryActionDetail);
    const arts = targets.map((di: any) => {
      const id = itemId(di.name); const meta = fileMeta(di.mimeType);
      return { id: `${meta.kind === "folder" ? "gfolder" : "gdoc"}:${id}`, kind: meta.kind, label: renamedTo ?? di.title ?? id, ...(role ? { role } : {}) };
    });
    if (!arts.length) continue;
    const primary = detailToAction(act.primaryActionDetail, actors);
    const ts = act.timestamp ?? act.timeRange?.endTime ?? new Date().toISOString();
    const dur = act.timeRange?.startTime && act.timeRange?.endTime ? Date.parse(act.timeRange.endTime) - Date.parse(act.timeRange.startTime) : undefined;
    const meta = fileMeta(targets[0]?.mimeType);
    const actorList = (act.actors ?? []).map((a: any) => driveActor(a, actors));
    const uniqActors = actorList.filter((a: Actor, i: number) => actorList.findIndex((b: Actor) => b.id === a.id) === i);
    // one event per distinct actor (Google groups co-editors into a single activity)
    for (const actor of uniqActors.length ? uniqActors : [driveActor(undefined)]) {
      const nActions = (act.actions ?? []).length || 1;
      out.push({
        project, actor,
        action: primary.action, action_detail: primary.detail,
        artifacts: arts,
        timestamp: ts, duration_ms: dur && dur > 0 ? dur : undefined,
        location: { system: "google-drive", url: meta.url(itemId(targets[0]?.name)) },
        intent: `${primary.summary}${nActions > 1 ? ` (${nActions} actions)` : ""} — ${arts.map((a: any) => a.label).join(", ")}`,
        caused_by,
        change: { summary: primary.summary },
        method: { tool: meta.tool, automated: actor.type === "system", params: { actions: nActions, source: payload.source ?? "drive-activity" } },
        idempotency_key: `gd:${actor.id}:${arts[0].id}:${primary.action}${primary.detail ? ":" + primary.detail : ""}:${ts}`,
        tags: ["google-drive", meta.kind],
      });
    }
  }
  return out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}
