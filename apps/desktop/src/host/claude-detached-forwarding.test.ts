import { expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { shouldForwardClaudeDetachedEvent } from "./claude-detached-forwarding.js";

const agents = (count: number): AgentEvent => ({ type: "engine_background_agents", count, abandoned: false });
const end = { type: "subagent_end", toolCallId: "t" } as unknown as AgentEvent;
const other = { type: "text_delta", text: "x" } as unknown as AgentEvent;

it("forwards everything for the owning runtime", () => {
  for (const event of [agents(3), agents(0), end, other]) expect(shouldForwardClaudeDetachedEvent(true, event)).toBe(true);
});

it("lets a switched-away engine settle: subagent_end and a zero count only", () => {
  expect(shouldForwardClaudeDetachedEvent(false, end)).toBe(true);
  expect(shouldForwardClaudeDetachedEvent(false, agents(0))).toBe(true);
  expect(shouldForwardClaudeDetachedEvent(false, agents(1))).toBe(false);
  expect(shouldForwardClaudeDetachedEvent(false, other)).toBe(false);
});
