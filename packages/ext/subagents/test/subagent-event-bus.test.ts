import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubagentEventBus } from "../subagent-event-bus.js";

describe("subagent event bridge", () => {
  it("forwards approval traffic without exposing unrelated parent events", () => {
    const parent = createEventBus();
    const child = createSubagentEventBus(parent);
    const request = vi.fn();
    const reply = vi.fn();
    const unrelatedParent = vi.fn();
    const unrelatedChild = vi.fn();
    const started = vi.fn();

    parent.on("subagents:bash_gate:approval", request);
    child.on("subagents:bash_gate:approval:reply:r1", reply);
    parent.on("private:parent", unrelatedParent);
    child.on("private:parent", unrelatedChild);
    child.on("subagents:started", started);

    child.emit("subagents:bash_gate:approval", { requestId: "r1" });
    parent.emit("subagents:bash_gate:approval:reply:r1", { outcome: "allow" });
    child.emit("private:parent", {});
    parent.emit("private:parent", {});
    parent.emit("subagents:started", { id: "agent-1", generation: 2 });

    expect(request).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith({ outcome: "allow" });
    expect(unrelatedParent).toHaveBeenCalledOnce();
    expect(unrelatedChild).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledWith({ id: "agent-1", generation: 2 });
  });
});
