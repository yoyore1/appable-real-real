import type { AgentStatusEvent } from "@appable/shared";

/** Plain-language status for the build screen — no file paths or dev jargon. */
export function friendlyBuildStatus(
  agentStatus: AgentStatusEvent | null,
  progress: number,
): string {
  if (agentStatus?.status === "done") return "It's alive. Go play with it.";

  const phase = agentStatus?.status;
  switch (phase) {
    case "planning":
      return progress < 12 ? "Getting things ready..." : "Planning your app...";
    case "writing":
      if (progress < 35) return "Laying the foundation...";
      if (progress < 55) return "Building your screens...";
      if (progress < 70) return "Adding the details...";
      return "Almost there...";
    case "installing":
      return "Getting everything set up...";
    case "checking":
      return "Making sure it all works...";
    case "fixing":
      return "Polishing a few things...";
    default:
      return "Building your app...";
  }
}

/** Turn build log lines into short, human-readable activity. */
export function friendlyBuildLogLine(text: string, source: string): string | null {
  if (text.startsWith("wrote ")) {
    const path = text.slice(6).replace(/\\/g, "/").toLowerCase();
    if (path.includes("homescreen") || /home[^/]*\.tsx/.test(path)) {
      return "Set up your home screen";
    }
    if (path.includes("screen")) return "Built a new screen";
    if (path.includes("component") || path.includes("layout")) return "Designed the look and feel";
    if (path.includes("navigation") || path.includes("router")) return "Connected your screens";
    if (path.includes("storage") || path.includes("/data") || path.includes("/lib/")) {
      return "Set up how your app saves things";
    }
    if (path.includes("theme") || path.includes("color") || path.includes("style")) {
      return "Applied your colors and style";
    }
    return "Added a new piece of your app";
  }
  if (text.startsWith("deleted ")) return "Cleaned something up";
  if (source === "agent") {
    if (/<\/?\w*:?tool_call|<parameter|invokename=/i.test(text)) return null;
    if (/plan:/i.test(text) || /^\*\*plan/i.test(text.trim())) return "Made a game plan";
    if (text.includes("BUILD COMPLETE") || text.includes("EDIT COMPLETE")) return null;
    if (text.length > 100) return null;
  }
  if (source === "system" && /iteration limit|checkpoint failed/i.test(text)) return null;
  if (/tool error|failed:/i.test(text)) return "Hit a snag — fixing it";
  return null;
}
