import type { AgentEvent } from "@anycode/core";

// Extracted from host/index.ts so the forwarding rule can be unit-tested:
// index.ts is the host entry module and cannot be imported by tests.

/**
 * Whether a detached event of the Claude CLI's own agents reaches the session.
 * Only the engine the session runs on speaks for its cards and count, with one
 * exception: an engine the session already switched away from still settles
 * what died with it (subagent_end, a zero background-agent count), or its
 * cards and badge would keep spinning.
 */
export function shouldForwardClaudeDetachedEvent(ownsRuntime: boolean, event: AgentEvent): boolean {
  if (ownsRuntime) return true;
  if (event.type === "subagent_end") return true;
  return event.type === "engine_background_agents" && event.count === 0;
}
