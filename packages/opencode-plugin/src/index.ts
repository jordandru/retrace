/**
 * Retrace identity guard for the OpenCode seat.
 *
 * Loaded two ways, both in v1 (docs/design/opencode-seat.md):
 *   - by the seat config `opencode.retrace.json`, via scripts/opencode-seat.sh (the supported path);
 *   - globally from ~/.config/opencode, so a bare `opencode` started by another tool in a Retrace
 *     worktree is still guarded. Outside a Retrace worktree the plugin does nothing at all.
 *
 * `opencode --pure` disables external plugins, so a deliberate --pure run has no guard. That
 * residual path is stated in the design note rather than papered over.
 */
import { isRetraceWorktree } from "./worktree.js";
import {
  NO_SEAT_FILE_REASON,
  checkCommitCommand,
  checkModel,
  editedPaths,
  loggedPaths,
  readPromptIdentity,
  refusalPrompt,
  retraceTool,
  uncoveredFiles,
} from "./guard.js";

type SessionState = {
  model?: string;
  /** Some prompt in this session carried the seat instruction file. */
  sawSeat: boolean;
  /** Set the moment another seat's identity appears in any prompt. */
  foreign?: string;
  edited: Set<string>;
  logged: Set<string>;
};

// Only plugin factories may be exported from this runtime entrypoint.
const RetraceGuardPlugin = async (input: { worktree?: string; directory?: string }) => {
  const root = input.worktree || input.directory || "";
  if (!isRetraceWorktree(root)) return {};

  const sessions = new Map<string, SessionState>();
  const state = (id: string): SessionState => {
    let s = sessions.get(id);
    if (!s) {
      s = { sawSeat: false, edited: new Set(), logged: new Set() };
      sessions.set(id, s);
    }
    return s;
  };
  /** Another seat's identity seen in a prompt with no session id attached. */
  let foreignAnywhere: string | null = null;

  /** Why this session may not act, or null. */
  const blocked = (s: SessionState): string | null => s.foreign ?? foreignAnywhere ?? (s.sawSeat ? null : NO_SEAT_FILE_REASON);

  return {
    "chat.message": async (
      msg: { sessionID: string; model?: { providerID: string; modelID: string } },
    ) => {
      if (msg.model?.providerID && msg.model?.modelID) {
        state(msg.sessionID).model = `${msg.model.providerID}/${msg.model.modelID}`;
      }
    },

    "chat.params": async (params: { sessionID: string; model?: unknown; provider?: unknown }) => {
      const model = params.model as { id?: string; modelID?: string } | undefined;
      const provider = params.provider as { id?: string; providerID?: string } | undefined;
      const providerID = provider?.id ?? provider?.providerID;
      const modelID = model?.id ?? model?.modelID;
      if (providerID && modelID) state(params.sessionID).model = `${providerID}/${modelID}`;
    },

    // A session builds several prompts and only the agent's own carries the instruction files,
    // so a prompt without the seat file is recorded, not refused; a prompt with another seat's
    // identity is refused where it stands. What a session may DO is decided in the tool hooks.
    "experimental.chat.system.transform": async (
      ctx: { sessionID?: string },
      output: { system: string[] },
    ) => {
      const identity = readPromptIdentity(output.system);
      const s = ctx.sessionID ? state(ctx.sessionID) : null;
      if (identity.carriesSeat && s) s.sawSeat = true;
      if (!identity.foreign) return;
      if (s) s.foreign = identity.foreign;
      else foreignAnywhere = identity.foreign;
      // OpenCode retains the original array when building the provider request.
      // Replacing output.system changes only the hook wrapper, not that request.
      output.system.splice(0, output.system.length, refusalPrompt(identity.foreign));
      console.error(`Retrace guard: refusing this session — ${identity.foreign}`);
    },

    "permission.ask": async (permission: { sessionID?: string }, output: { status: "ask" | "deny" | "allow" }) => {
      const reason = blocked(state(permission.sessionID ?? "unknown"));
      if (reason) output.status = "deny";
    },

    "tool.execute.before": async (
      call: { tool: string; sessionID: string },
      output: { args: any },
    ) => {
      const s = state(call.sessionID);
      const reason = blocked(s);
      if (reason) {
        console.error(`Retrace guard: refusing this session — ${reason}`);
        throw new Error(`Retrace guard: ${reason}`);
      }
      const args = output.args ?? {};

      const retrace = retraceTool(call.tool);
      if (retrace) {
        const verdict = checkModel(s.model, args?.actor?.model);
        if (!verdict.ok) throw new Error(`Retrace guard: ${verdict.reason}`);
        if (retrace === "log") for (const p of loggedPaths(args)) s.logged.add(p);
        return;
      }

      if (typeof args.command === "string") {
        const verdict = checkCommitCommand(args.command);
        if (!verdict.ok) throw new Error(`Retrace guard: ${verdict.reason}`);
        const uncovered = uncoveredFiles(s.edited, s.logged);
        if (uncovered.length > 0 && /\bcommit\b/.test(args.command)) {
          throw new Error(
            `Retrace guard: these files were edited but never named in a retrace_log (agent-rules 3): ${uncovered.join(", ")}`,
          );
        }
      }
    },

    "tool.execute.after": async (call: { tool: string; sessionID: string; args: unknown }) => {
      for (const p of editedPaths(call.tool, call.args)) state(call.sessionID).edited.add(p);
    },
  };
};

export default RetraceGuardPlugin;
