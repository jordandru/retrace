import type { Event } from "@retrace-dev/core";

/** Machine receipt from the appended event, never from the caller's proposed body.
 * Remote seals are the Worker's stamps. A local store has no credential authority,
 * even if a caller put seal-looking fields in method.params. This is transport
 * evidence for the connected client, not a portable signature verification. */
export function logReceipt(event: Event, remote: boolean) {
  const params = event.method?.params;
  return {
    version: 1,
    storage: remote ? "remote" : "local",
    id: event.id,
    seq: event.seq,
    hash: event.hash,
    project: event.project,
    action: event.action,
    actor: {
      type: event.actor.type,
      id: event.actor.id,
      ...(event.actor.model ? { model: event.actor.model } : {}),
      ...(event.actor.model_source ? { model_source: event.actor.model_source } : {}),
    },
    ...(event.caused_by ? { caused_by: event.caused_by } : {}),
    artifacts: event.artifacts.map(({ id, role }) => ({ id, ...(role ? { role } : {}) })),
    ...(remote ? {
      sealed_by: typeof params?.sealed_by === "string" ? params.sealed_by : null,
      producer_sig_verdict: typeof params?.producer_sig_verdict === "string" ? params.producer_sig_verdict : null,
    } : {}),
  };
}
