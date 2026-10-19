import type { OrcaRunResult } from "./pane-screen-observer.js";

export type OrcaPromptReceiptEvidence = {
  status: "turn_started" | "accepted" | "refused" | "invalid" | "failed";
  accepted: true | false | "unknown";
  handle?: string;
  bytes_written?: number;
  request_id?: string;
  stages?: string[];
  provider?: string;
  observation?: string;
  process_incarnation?: string;
  generation?: number;
  baseline_working_sequence?: number;
  mutation_replayed?: boolean;
  refused_reason?: string;
  error_preview?: string;
};

export type OrcaSendReceiptAssessment = {
  accepted: true | false | "unknown";
  delivered: true | false | "unknown";
  reason?: string;
  receipt: OrcaPromptReceiptEvidence;
};

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function errorPreview(result: OrcaRunResult): string | undefined {
  const preview = (result.stderr || result.stdout).trim().slice(0, 300);
  return preview || undefined;
}

/**
 * Interpret Orca's request-bound agent-prompt receipt. Input acceptance is not submission: only a valid receipt whose
 * ordered additive stages contain `input_accepted` before `turn_started` proves delivery. Process/transport failure is
 * unknown unless a successful envelope explicitly returns accepted:false with zero bytes for the expected handle.
 */
export function assessOrcaSendReceipt(
  result: OrcaRunResult,
  expectedTerminal: string,
  expectedProvider: string,
  expectedProcessIncarnation: string,
): OrcaSendReceiptAssessment {
  const parsed = parseJson(result.stdout);
  const envelope = isRecord(parsed) ? parsed : undefined;
  const resultRecord = envelope && isRecord(envelope.result) ? envelope.result : undefined;
  const send = resultRecord && isRecord(resultRecord.send) ? resultRecord.send : undefined;
  const mutation = resultRecord && isRecord(resultRecord.mutation) ? resultRecord.mutation : undefined;
  const handle = boundedString(send?.handle, 200);
  const bytesWritten = Number.isSafeInteger(send?.bytesWritten) && Number(send?.bytesWritten) >= 0
    ? Number(send?.bytesWritten)
    : undefined;
  const refusedReason = boundedString(send?.refusedReason, 200);
  const base = {
    ...(handle ? { handle } : {}),
    ...(bytesWritten !== undefined ? { bytes_written: bytesWritten } : {}),
  };
  const validEnvelope = envelope?.ok === true && send !== undefined && handle === expectedTerminal;

  // Orca intentionally exits 1 when the runtime returns accepted:false. The structured zero-byte refusal is stronger
  // evidence than that generic process status; every other nonzero result remains effect-unknown.
  if (validEnvelope && send.accepted === false && bytesWritten === 0) {
    return {
      accepted: false,
      delivered: false,
      reason: refusedReason ? `orca_send_refused: ${refusedReason}` : "orca_send_refused",
      receipt: { status: "refused", accepted: false, ...base, ...(refusedReason ? { refused_reason: refusedReason } : {}) },
    };
  }

  if (result.code !== 0) {
    return {
      accepted: "unknown",
      delivered: "unknown",
      reason: `orca_send_failed: exit ${result.code}`,
      receipt: { status: "failed", accepted: "unknown", ...base, ...(errorPreview(result) ? { error_preview: errorPreview(result) } : {}) },
    };
  }

  if (!validEnvelope || send.accepted !== true || bytesWritten === undefined || bytesWritten === 0) {
    return {
      accepted: "unknown",
      delivered: "unknown",
      reason: "orca_send_receipt_invalid",
      receipt: { status: "invalid", accepted: "unknown", ...base, ...(errorPreview(result) ? { error_preview: errorPreview(result) } : {}) },
    };
  }

  const prompt = isRecord(send.prompt) ? send.prompt : undefined;
  const requestId = boundedString(prompt?.requestId, 200);
  const provider = boundedString(prompt?.provider, 64);
  const observation = boundedString(prompt?.observation, 200);
  const processIncarnation = boundedString(prompt?.processIncarnation, 200);
  const generation = Number.isSafeInteger(prompt?.generation) && Number(prompt?.generation) >= 0
    ? Number(prompt?.generation)
    : undefined;
  const baselineWorkingSequence = Number.isSafeInteger(prompt?.baselineWorkingSequence)
    && Number(prompt?.baselineWorkingSequence) >= 0
    ? Number(prompt?.baselineWorkingSequence)
    : undefined;
  const stages = Array.isArray(prompt?.stages)
    && prompt.stages.length <= 16
    && prompt.stages.every((stage) => boundedString(stage, 64) !== undefined)
    ? [...prompt.stages] as string[]
    : undefined;
  const inputAcceptedAt = stages?.indexOf("input_accepted") ?? -1;
  const turnStartedAt = stages?.indexOf("turn_started") ?? -1;
  const mutationRequestId = boundedString(mutation?.requestId, 200);
  const mutationReplayed = typeof mutation?.replayed === "boolean" ? mutation.replayed : undefined;

  if (!prompt || !stages || !requestId || !provider || !observation || !processIncarnation
    || generation === undefined || baselineWorkingSequence === undefined || inputAcceptedAt < 0
    || processIncarnation !== expectedProcessIncarnation || mutationRequestId !== requestId
    || mutationReplayed === undefined
    || (turnStartedAt >= 0 && turnStartedAt <= inputAcceptedAt)) {
    return {
      accepted: true,
      delivered: "unknown",
      reason: "orca_send_receipt_invalid",
      receipt: { status: "invalid", accepted: true, ...base },
    };
  }

  const promptEvidence = {
    ...base,
    request_id: requestId,
    stages,
    provider,
    observation,
    process_incarnation: processIncarnation,
    generation,
    baseline_working_sequence: baselineWorkingSequence,
    mutation_replayed: mutationReplayed,
  };
  if (turnStartedAt >= 0) {
    const supportedProof = observation === "supported"
      && (provider === "codex" || provider === "claude")
      && provider === expectedProvider;
    return supportedProof
      ? { accepted: true, delivered: true, receipt: { status: "turn_started", accepted: true, ...promptEvidence } }
      : {
        accepted: true,
        delivered: "unknown",
        reason: "orca_send_receipt_invalid",
        receipt: { status: "invalid", accepted: true, ...promptEvidence },
      };
  }
  return {
    accepted: true,
    delivered: "unknown",
    reason: "turn_start_unobserved",
    receipt: { status: "accepted", accepted: true, ...promptEvidence },
  };
}
