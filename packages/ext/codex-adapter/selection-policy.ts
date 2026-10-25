import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hosts must supply soft startup restrictions: Pi's registry exposes only hard ceilings. */
export interface AdapterSelectionPolicy {
  tools?: readonly string[];
  noTools?: "all" | "builtin";
}

function matches(name: string, patterns: readonly string[] | undefined): boolean {
  return (
    patterns?.some((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(name);
    }) === true
  );
}

export function resolveSelectionPolicy(pi: ExtensionAPI, policy: AdapterSelectionPolicy) {
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  const settings = pi.getSettings();
  const defaults = settings.defaultTools;
  const resolved = SettingsManager.inMemory(settings).getDefaultTools();
  const explicitDefaults =
    defaults?.length === 0 ||
    defaults?.some((name) => !name.startsWith("+") && !name.startsWith("-"));
  const explicitTools =
    policy.tools !== undefined &&
    (policy.tools.length === 0 ||
      policy.tools.some((name) => !name.startsWith("+") && !name.startsWith("-")));
  const directive = (entries: readonly string[] | undefined, name: string) =>
    entries?.filter((entry) => entry === `+${name}` || entry === `-${name}`).at(-1);
  const permits = (name: string) =>
    registered.has(name) &&
    (directive(policy.tools, name) ?? (explicitTools ? undefined : directive(defaults, name))) !==
      `-${name}`;
  const selectedByPolicy = (name: string) => {
    if (explicitTools) return matches(name, policy.tools);
    const override = directive(policy.tools, name);
    if (override) return override === `+${name}`;
    return !explicitDefaults || matches(name, resolved);
  };
  return {
    permits,
    seedCodemode: permits("codemode") && selectedByPolicy("codemode"),
    permitsRestore: (name: string) => {
      if (!permits(name)) return false;
      if (!["read", "bash", "edit", "write"].includes(name)) return true;
      if (policy.noTools && !explicitTools && directive(policy.tools, name) !== `+${name}`)
        return false;
      return selectedByPolicy(name);
    },
  };
}
