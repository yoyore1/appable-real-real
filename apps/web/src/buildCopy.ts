import type { AgentStatusEvent } from "@appable/shared";

/** Plain-language status for the build screen — no file paths or dev jargon. */
export function friendlyBuildStatus(
  agentStatus: AgentStatusEvent | null,
  progress: number,
): string {
  if (agentStatus?.status === "done") {
    return agentStatus.message?.trim() || "Your app is ready.";
  }

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

/** Plain-language label for a tap-to-edit change shown in the build chat. */
export function friendlyTapEditMessage(changes: string[]): string {
  const parts = changes.map(friendlyTapEditChange);
  if (parts.length === 0) return "Made a visual change";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function isLikelyIconOrEmoji(text: string): boolean {
  const t = text.trim();
  if (!t || t === "icon") return true;
  if (t.length <= 2 && /\p{Extended_Pictographic}|\p{So}/u.test(t)) return true;
  return t.length === 1 && !/[a-zA-Z0-9]/.test(t);
}

function stripEmojiForDisplay(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\uFE0F/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function friendlyTapEditChange(change: string): string {
  const removeIcon = change.match(/^remove the icon from the container for "(.+)"$/u);
  if (removeIcon) return `Remove the icon from "${removeIcon[1]}"`;
  if (change === "remove the icon from this element") return "Remove the icon";
  const replace = change.match(/^replace the text "(.+)" with "(.*)"$/u);
  if (replace) {
    if (!replace[2]) {
      if (isLikelyIconOrEmoji(replace[1])) return "Remove the icon";
      if (stripEmojiForDisplay(replace[1]) !== replace[1].trim()) {
        return `Remove emoji from "${stripEmojiForDisplay(replace[1])}"`;
      }
      return `Remove "${replace[1]}"`;
    }
    return `Change "${replace[1]}" to "${replace[2]}"`;
  }
  const textMatch = change.match(/^set the text to "(.*)"$/u);
  if (textMatch) return `Change the text to "${textMatch[1]}"`;
  const textColorScoped = change.match(/^set the text color of "(.+)" to (#[0-9A-Fa-f]{3,8})$/u);
  if (textColorScoped) return `Change "${textColorScoped[1]}" text color`;
  if (change.startsWith("set the text color to ")) return "Change the text color";
  const bgScoped = change.match(
    /^set the background color of the container for "(.+)" to (#[0-9A-Fa-f]{3,8})$/u,
  );
  if (bgScoped) return `Change the ${bgScoped[1]} card background`;
  if (change.startsWith("set the background color to ")) return "Change the background color";
  return change;
}

/** Hide tap-to-edit internals when rendering build chat (live or from history). */
export function formatBuildChatDisplay(text: string): string {
  const m = text.match(
    /^\[Tap edit\] In the app, find .+ and (.+)\. Change only (?:this element|the matching text|what was tapped)\.$/,
  );
  if (!m) return text;
  return friendlyTapEditMessage(m[1].split("; ").filter(Boolean));
}
