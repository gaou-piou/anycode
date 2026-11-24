import type { AgentEvent } from "@anycode/core";
import type { ClaudeStreamMessage } from "./protocol.js";

type Task = Extract<AgentEvent, { type: "claude_background_task" }>;

/** Tracks explicit native task lifecycle frames. Unknown task types are ignored. */
export class ClaudeNativeBackgroundTasks {
  private readonly tasks = new Map<string, Task>();
  private readonly runs = new Map<string, string>();
  /**
   * Tasks the CLI tracks for a FOREGROUND tool call (`is_backgrounded:false`),
   * of any task type: a long Bash command or a foreground Agent. CLI 2.1.330
   * emits their terminal notification BEFORE the owner's own tool_result and
   * starts no autonomous turn for it. An id leaves the set only on a
   * `task_updated` patch that backgrounds it, on its own terminal
   * notification, or when observation ends — never on the tool_result, whose
   * position relative to the notification is not part of the contract.
   */
  private readonly foreground = new Map<string, string | undefined>();
  /**
   * Tasks a SUBAGENT started (`owned_by_subagent:true` on `task_started`), of
   * any task type, keyed by id and run. Kept apart from `foreground`: a
   * backgrounding patch deletes a foreground entry, but the task stays the
   * subagent's, whose own report covers it.
   */
  private readonly subagentOwned = new Set<string>();

  private static ownedKey(id: string, run: unknown): string {
    return `${id}\0${typeof run === "string" ? run : ""}`;
  }

  /** A frame naming another run of a reused task id must not touch this run's state. */
  private foregroundRunMatches(id: string, f: Record<string, unknown>): boolean {
    if (!this.foreground.has(id)) return false;
    const run = this.foreground.get(id);
    return run === undefined || typeof f.run_id !== "string" || f.run_id === run;
  }

  /**
   * True for a terminal notification after which the CLI starts NO turn of its
   * own, so nothing may wait for one. Consumes the id, so each notification is
   * classified once. Three kinds (CLI 2.1.330 captures):
   * - a foreground task: it settles the running tool call itself (w0-20, w0-21);
   * - a task a subagent owns: the subagent's own report covers it, the main
   *   session gets no turn (w0-23 `bdcsig06x`, w0-24 `baqf2b3lc`);
   * - work that was stopped or killed, whether a command after an interrupt
   *   (w0-24) or the agent itself (w0-25, `task_updated killed` then
   *   `task_notification stopped`).
   */
  takeTurnlessCompletion(frame: ClaudeStreamMessage): boolean {
    if (frame.type !== "system" || frame.subtype !== "task_notification") return false;
    const f = frame as Record<string, unknown>;
    const id = f.task_id;
    if (typeof id !== "string") return false;
    const foreground = this.foregroundRunMatches(id, f) && this.foreground.delete(id);
    const ownedKey = [ClaudeNativeBackgroundTasks.ownedKey(id, f.run_id), ClaudeNativeBackgroundTasks.ownedKey(id, undefined)].find(key => this.subagentOwned.has(key));
    if (ownedKey) this.subagentOwned.delete(ownedKey);
    return foreground || ownedKey !== undefined || f.status === "stopped" || f.status === "killed";
  }

  /** Transport loss does not establish whether the native command stopped. */
  abandonAll(): Task[] {
    this.foreground.clear();
    this.subagentOwned.clear();
    const changed: Task[] = [];
    for (const [id, task] of this.tasks) {
      if (task.status !== "running") continue;
      const unknown: Task = { ...task, status: "unknown", summary: "Claude connection ended; task status is unknown." };
      this.tasks.set(id, unknown);
      changed.push(unknown);
    }
    return changed;
  }

  knowsNotification(frame: ClaudeStreamMessage): boolean {
    if (frame.type !== "system" || frame.subtype !== "task_notification") return false;
    const f = frame as Record<string, unknown>;
    if (typeof f.task_id !== "string") return false;
    const task = this.tasks.get(f.task_id);
    if (!task || (typeof f.tool_use_id === "string" && f.tool_use_id !== task.toolCallId)) return false;
    const run = this.runs.get(f.task_id);
    return !(run && typeof f.run_id === "string" && run !== f.run_id);
  }

  onFrame(frame: ClaudeStreamMessage): Task | undefined {
    if (frame.type !== "system") return undefined;
    const f = frame as Record<string, unknown>;
    const id = typeof f.task_id === "string" && f.task_id ? f.task_id : undefined;
    if (!id) return undefined;
    if (f.subtype === "task_started") {
      if (f.is_backgrounded === false) this.foreground.set(id, typeof f.run_id === "string" && f.run_id ? f.run_id : undefined);
      else this.foreground.delete(id);
      const owned = ClaudeNativeBackgroundTasks.ownedKey(id, f.run_id);
      if (f.owned_by_subagent === true) this.subagentOwned.add(owned);
      else this.subagentOwned.delete(owned);
      const kind = f.task_type === "local_bash" ? "bash" : f.task_type === "monitor" || f.task_type === "local_monitor" ? "monitor" : undefined;
      if (!kind || typeof f.tool_use_id !== "string" || !f.tool_use_id) return undefined;
      const task: Task = { type: "claude_background_task", taskId: id, toolCallId: f.tool_use_id, kind,
        description: typeof f.description === "string" ? f.description : "", startedAt: Date.now(), status: "running",
        ...(f.is_backgrounded === false ? { foreground: true as const } : {}) };
      this.tasks.set(id, task);
      if (typeof f.run_id === "string") this.runs.set(id, f.run_id);
      else this.runs.delete(id);
      return task;
    }
    if (f.subtype === "task_updated") {
      const patch = f.patch && typeof f.patch === "object" ? f.patch as Record<string, unknown> : undefined;
      if (patch?.is_backgrounded !== true) return undefined;
      if (this.foregroundRunMatches(id, f)) this.foreground.delete(id);
      const current = this.tasks.get(id);
      const run = this.runs.get(id);
      if (!current?.foreground || current.status !== "running" || (run && typeof f.run_id === "string" && run !== f.run_id)) return undefined;
      // Moved to the background: from now on it is a background task for display.
      const { foreground: _foreground, ...moved } = current;
      this.tasks.set(id, moved);
      return moved;
    }
    const old = this.tasks.get(id);
    if (!old || (old.status !== "running" && !(old.status === "unknown" && f.subtype === "task_notification")) || (typeof f.tool_use_id === "string" && f.tool_use_id !== old.toolCallId)) return undefined;
    const run = this.runs.get(id);
    if (run && typeof f.run_id === "string" && run !== f.run_id) return undefined;
    if (f.subtype === "task_progress") {
      if (typeof f.description !== "string" || f.description === old.description) return undefined;
      const task = { ...old, description: f.description };
      this.tasks.set(id, task);
      return task;
    }
    if (f.subtype !== "task_notification") return undefined;
    const status = f.status === "completed" ? "completed" : f.status === "failed" ? "failed" : f.status === "stopped" || f.status === "killed" ? "stopped" : undefined;
    if (!status) return undefined;
    const task: Task = { ...old, status,
      ...(typeof f.summary === "string" ? { summary: f.summary } : {}),
      ...(typeof f.output_file === "string" ? { outputFile: f.output_file } : {}) };
    if (old.status === "unknown" && typeof f.summary !== "string") delete task.summary;
    this.tasks.set(id, task);
    return task;
  }
}
