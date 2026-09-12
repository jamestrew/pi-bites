export interface AdapterModel {
  provider?: string;
  id?: string;
  api?: string;
  input?: ("text" | "image")[];
}

const CODE_MODE_TOOLS = ["exec", "wait"] as const;
const CORE = new Set(["read", "bash", "edit", "write"]);
export const NESTED_TOOLS = [
  "exec_command",
  "write_stdin",
  "apply_patch",
  "web_run",
  "view_image",
] as const;
const OWNED = new Set([...CORE, ...NESTED_TOOLS, "exec", "wait"]);
const PREFIXES = new Set([
  "openai",
  "openai-codex",
  "azure",
  "azure-openai",
  "github-copilot",
  "openrouter",
]);

export function isAdapterModel(model: AdapterModel | undefined): boolean {
  let id = model?.id?.trim().toLowerCase() ?? "";
  const slash = id.indexOf("/");
  if (slash >= 0) {
    if (!PREFIXES.has(id.slice(0, slash))) return false;
    id = id.slice(slash + 1);
  }
  return /^gpt-(?:5\.6|6)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(id);
}

interface DisplacedTool {
  name: string;
  index: number;
  before?: string;
}
interface SessionSelection {
  tools: Set<string>;
  disabledVisible: Set<string>;
}
interface ActiveProjection {
  kind: "active";
  displaced: DisplacedTool[];
  nested: Set<string>;
  visible: Set<string>;
}
export interface AdapterToolState {
  // Tool selection is first available from session_start, after Pi binds its API.
  selection: SessionSelection | undefined;
  projection: { kind: "inactive" } | ActiveProjection;
}
export function createAdapterToolState(): AdapterToolState {
  return { selection: undefined, projection: { kind: "inactive" } };
}
export function getNestedTools(state: AdapterToolState): ReadonlySet<string> {
  return state.projection.kind === "active" ? state.projection.nested : new Set();
}

function activate(active: string[], selection: SessionSelection): ActiveProjection {
  const hasShell = active.includes("bash");
  const hasPatch = active.includes("edit") || active.includes("write");
  return {
    kind: "active",
    displaced: [],
    nested: new Set(
      NESTED_TOOLS.filter((name) => {
        if (!selection.tools.has(name)) return false;
        if (name === "exec_command" || name === "write_stdin") return hasShell;
        if (name === "apply_patch") return hasPatch;
        return true;
      }),
    ),
    visible: new Set(
      CODE_MODE_TOOLS.filter(
        (name) => selection.tools.has(name) && !selection.disabledVisible.has(name),
      ),
    ),
  };
}

function restore(tools: string[], displaced: DisplacedTool[]): string[] {
  const restored = [...tools];
  for (const tool of displaced) {
    if (restored.includes(tool.name)) continue;
    const before = tool.before === undefined ? -1 : restored.indexOf(tool.before);
    restored.splice(before < 0 ? Math.min(tool.index, restored.length) : before, 0, tool.name);
  }
  return restored;
}

/** Restore tools whenever their replacement disappears, including within supported scope.
 * Initial selection and explicit exec/wait disables survive projection changes.
 */
export function reconcileTools(
  active: string[],
  enabled: boolean,
  state: AdapterToolState,
): string[] {
  const selection = (state.selection ??= { tools: new Set(active), disabledVisible: new Set() });
  const previous = state.projection;
  for (const name of CODE_MODE_TOOLS) {
    if (active.includes(name)) {
      // An explicit addition is authoritative, including after a prior disable.
      selection.tools.add(name);
      selection.disabledVisible.delete(name);
    } else if (previous.kind === "active" && previous.visible.has(name)) {
      selection.disabledVisible.add(name);
    }
  }
  const retained = active.filter((name) => CORE.has(name) || !OWNED.has(name));
  const restored = restore(retained, previous.kind === "active" ? previous.displaced : []);
  if (!enabled) {
    state.projection = { kind: "inactive" };
    return restored;
  }
  // Recompute from the current normal selection, including the cores we own.
  // A core removed after restoration must not survive in cached nested membership.
  const projection = activate(restored, selection);
  const replaces = (name: string) =>
    projection.visible.has("exec") &&
    (name === "read" || name === "bash"
      ? projection.nested.has("exec_command")
      : (name === "edit" || name === "write") && projection.nested.has("apply_patch"));
  for (const [index, name] of restored.entries()) {
    if (replaces(name)) {
      projection.displaced.push({
        name,
        index,
        before: restored.slice(index + 1).find((tool) => !OWNED.has(tool)),
      });
    }
  }
  const visible = restored.filter((name) => !replaces(name));
  const index = Math.min(projection.displaced[0]?.index ?? visible.length, visible.length);
  visible.splice(index, 0, ...CODE_MODE_TOOLS.filter((name) => projection.visible.has(name)));
  state.projection = projection;
  return visible;
}
