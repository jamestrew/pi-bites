const CORE_TOOLS = ["edit", "write"] as const;
const OWNED_TOOLS = new Set<string>([...CORE_TOOLS, "apply_patch"]);

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
    [provider, normalize(model.id), normalize(model.api)].some((value) => value.includes("codex"))
  );
}

function recordDisplaced(activeTools: string[]): DisplacedTool[] {
  return activeTools.flatMap((name, index): DisplacedTool[] => {
    if (name !== "edit" && name !== "write") return [];
    return [
      {
        name,
        index,
        before: activeTools.slice(index + 1).find((tool: string) => !OWNED_TOOLS.has(tool)),
      },
    ];
  });
}

function activate(activeTools: string[], state: AdapterToolState): string[] {
  if (!state.active) {
    state.displaced = recordDisplaced(activeTools);
    state.patchIndex = state.displaced[0]?.index;
  }
  state.active = true;

  const unrelated = activeTools.filter((name) => !OWNED_TOOLS.has(name));
  if (!state.displaced?.length) return unrelated;
  const ownedIndex = activeTools.findIndex((name) => OWNED_TOOLS.has(name));
  const index = Math.min(
    ownedIndex < 0 ? (state.patchIndex ?? unrelated.length) : ownedIndex,
    unrelated.length,
  );
  unrelated.splice(index, 0, "apply_patch");
  return unrelated;
}

function restore(activeTools: string[], state: AdapterToolState): string[] {
  if (!state.active) return activeTools.filter((name) => name !== "apply_patch");
  const restored = activeTools.filter((name) => name !== "apply_patch");
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
): string[] {
  return shouldActivate ? activate(activeTools, state) : restore(activeTools, state);
}
