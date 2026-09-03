import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { type AgentManager } from "./agent-manager.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import {
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "./settings.js";
import { type AgentRecord } from "./types.js";
import { SUBAGENT_TYPES } from "./types.js";
import { type AgentActivity, formatDuration, getDisplayName } from "./ui/agent-format.js";

type AgentsCommandDeps = {
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  getModelLabelFromConfig: (model: string) => string;
  isScopeModelsEnabled: () => boolean;
  setScopeModelsEnabled: (enabled: boolean) => void;
  getToolDescriptionMode: () => ToolDescriptionMode;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  isFleetViewEnabled: () => boolean;
  setFleetViewEnabled: (enabled: boolean) => void;
};

export function registerAgentsCommand(pi: ExtensionAPI, deps: AgentsCommandDeps) {
  const {
    manager,
    agentActivity,
    getModelLabelFromConfig,
    isScopeModelsEnabled,
    setScopeModelsEnabled,
    getToolDescriptionMode,
    setToolDescriptionMode,
    isFleetViewEnabled,
    setFleetViewEnabled,
  } = deps;

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    const options: string[] = [];
    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(
        (agent) => agent.status === "running" || agent.status === "queued",
      ).length;
      const done = agents.filter((agent) => agent.status === "completed").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }
    options.push(`Agent types (${SUBAGENT_TYPES.length})`, "Settings");

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;
    if (choice.startsWith("Running agents (")) await showRunningAgents(ctx);
    else if (choice.startsWith("Agent types (")) await showAgentTypes(ctx);
    else if (choice === "Settings") await showSettings(ctx);
    await showAgentsMenu(ctx);
  }

  async function showAgentTypes(ctx: ExtensionCommandContext) {
    const options = SUBAGENT_TYPES.map((name) => {
      const config = DEFAULT_AGENTS[name];
      const model = config.model ? getModelLabelFromConfig(config.model) : "inherit";
      return `${name} — ${model}`;
    });
    await ctx.ui.select("Agent types", options);
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const options = agents.map((agent) => {
      const displayName = getDisplayName(agent.type);
      const duration = formatDuration(agent.startedAt, agent.completedAt);
      return `${displayName} (${agent.description}) · ${agent.toolUses} tools · ${agent.status} · ${duration}`;
    });
    const choice = await ctx.ui.select("Running agents", options);
    if (!choice) return;
    const record = agents[options.indexOf(choice)];
    if (!record) return;
    await viewAgentConversation(ctx, record);
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(
        `Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`,
        "info",
      );
      return;
    }

    const { CONVERSATION_OVERLAY_OPTIONS, ConversationViewer } =
      await import("./ui/conversation-viewer.js");
    const session = record.session;
    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) =>
        new ConversationViewer(
          tui,
          session,
          record,
          agentActivity.get(record.id),
          theme,
          done,
          () => {
            if (manager.abort(record.id)) ctx.ui.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => manager.steer(record.id, message),
          (message: string) => {
            if (manager.cancelAndSteer(record.id, message)) {
              ctx.ui.notify(`Canceled current operation for "${record.description}".`, "info");
            }
          },
        ),
      CONVERSATION_OVERLAY_OPTIONS,
    );
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      scopeModels: isScopeModelsEnabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
    };
  }

  const NUMERIC_IDS = new Set(["maxConcurrent"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const maxConcurrent = manager.getMaxConcurrent();
      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent agents (Enter to type)",
          currentValue: String(maxConcurrent),
          values: [String(maxConcurrent)],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description:
            "Claude Code-style main+subagents list above the editor (Ctrl+↑ to focus, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description:
            "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const count = Number.parseInt(value, 10);
        if (count >= 1) {
          manager.setMaxConcurrent(count);
          notifyApplied(ctx, `Max concurrency set to ${count}`);
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "toolDescriptionMode") {
        if (value !== "full" && value !== "compact" && value !== "custom") return;
        setToolDescriptionMode(value);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      }
    }

    let currentIndex = 0;
    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
      const items = buildItems();
      const list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => applyValue(id, newValue),
        () => done(undefined),
      );
      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "up")) currentIndex = Math.max(0, currentIndex - 1);
          else if (matchesKey(data, "down"))
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          const currentItem = items[currentIndex];
          if (matchesKey(data, Key.enter) && currentItem && NUMERIC_IDS.has(currentItem.id)) {
            done(currentItem.id);
            return;
          }
          list.handleInput(data);
        },
      };
    });

    if (!result || !NUMERIC_IDS.has(result)) return;
    let input = await ctx.ui.input("Max concurrency (1+)", String(manager.getMaxConcurrent()));
    while (input != null) {
      const trimmed = input.trim();
      const count = Number(trimmed);
      if (trimmed && Number.isInteger(count) && count >= 1) {
        applyValue(result, String(count));
        await showSettings(ctx);
        return;
      }
      input = await ctx.ui.input("Max concurrency (1+)", trimmed);
    }
  }

  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => showAgentsMenu(ctx),
  });
}
