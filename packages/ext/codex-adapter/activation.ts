const CORE_TOOLS = ["read", "bash", "edit", "write"] as const;
const ADAPTER_TOOLS = ["exec_command", "write_stdin", "apply_patch"] as const;
const OWNED_TOOLS = new Set<string>([...CORE_TOOLS, ...ADAPTER_TOOLS]);
const ADAPTER_TOOL_NAMES = new Set<string>(ADAPTER_TOOLS);

type CoreTool = (typeof CORE_TOOLS)[number];

export interface AdapterModel {
  provider?: string;
  id?: string;
  api?: string;
}

interface DisplacedTool {
  name: CoreTool;
  before?: string;
  index: number;
}

export interface AdapterToolState {
  displaced?: DisplacedTool[];
  active?: boolean;
  patchIndex?: number;
}

const normalize = (value: string | undefined): string => value?.trim().toLowerCase() ?? "";

export function isAdapterModel(model: AdapterModel | undefined, providers: string[]): boolean {
  if (!model) return false;
  const provider = normalize(model.provider);
  const configured = new Set(providers.map(normalize));
  return (
    configured.has(provider) ||
    normalize(model.id).startsWith("gpt-") ||
    [provider, normalize(model.id), normalize(model.api)].some((value) => value.includes("codex"))
  );
}

function recordDisplaced(activeTools: string[]): DisplacedTool[] {
  return activeTools.flatMap((name, index): DisplacedTool[] => {
    if (!CORE_TOOLS.includes(name as CoreTool)) return [];
    return [
      {
        name: name as CoreTool,
        index,
        before: activeTools.slice(index + 1).find((tool: string) => !OWNED_TOOLS.has(tool)),
      },
    ];
  });
}

function activate(activeTools: string[], state: AdapterToolState): string[] {
  const observed = recordDisplaced(activeTools);
  if (!state.active) state.displaced = [];
  state.displaced ??= [];
  for (const tool of observed) {
    if (!state.displaced.some((displaced) => displaced.name === tool.name)) {
      state.displaced.push(tool);
    }
  }
  state.patchIndex ??= observed[0]?.index;
  state.active = true;

  const unrelated = activeTools.filter((name) => !OWNED_TOOLS.has(name));
  if (state.displaced.length === 0) return unrelated;
  const ownedIndex = activeTools.findIndex((name) => OWNED_TOOLS.has(name));
  const index = Math.min(
    ownedIndex < 0 ? (state.patchIndex ?? unrelated.length) : ownedIndex,
    unrelated.length,
  );
  unrelated.splice(index, 0, ...ADAPTER_TOOLS);
  return unrelated;
}

function restore(activeTools: string[], state: AdapterToolState): string[] {
  if (!state.active) return activeTools.filter((name) => !ADAPTER_TOOL_NAMES.has(name));
  const restored = activeTools.filter((name) => !ADAPTER_TOOL_NAMES.has(name));
  for (const tool of state.displaced ?? []) {
    if (restored.includes(tool.name)) continue;
    const beforeIndex = tool.before === undefined ? -1 : restored.indexOf(tool.before);
    const index = beforeIndex >= 0 ? beforeIndex : Math.min(tool.index, restored.length);
    restored.splice(index, 0, tool.name);
  }
  delete state.displaced;
  delete state.patchIndex;
  state.active = false;
  return restored;
}

export function reconcileTools(
  activeTools: string[],
  shouldActivate: boolean,
  state: AdapterToolState,
  shouldActivateWeb = false,
): string[] {
  const reconciled = shouldActivate ? activate(activeTools, state) : restore(activeTools, state);
  const withoutWeb = reconciled.filter((name) => name !== "web_run");
  if (!shouldActivateWeb) return withoutWeb;
  if (shouldActivate) {
    const patchIndex = withoutWeb.indexOf("apply_patch");
    withoutWeb.splice(patchIndex < 0 ? withoutWeb.length : patchIndex + 1, 0, "web_run");
  } else {
    withoutWeb.push("web_run");
  }
  return withoutWeb;
}
