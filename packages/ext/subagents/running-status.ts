import { Container, Text } from "@earendil-works/pi-tui";
import { type Theme } from "./ui/agent-format.js";

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0),
  );
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}
