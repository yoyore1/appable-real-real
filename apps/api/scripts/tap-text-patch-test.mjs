import { parseTapEditRequest } from "../src/agent/tapEdit.ts";

const source = `import { Text, Pressable } from "react-native";

export function Home() {
  return (
    <Pressable testID="browse-recipes">
      <Text testID="browse-icon">{"📖"}</Text>
      <Text testID="browse-label">{"Browse Recipes"}</Text>
    </Pressable>
  );
}
`;

const hintSource = `<Text testID="day-hint">{"Tap to plan"}</Text>`;

// Inline minimal patch (mirror production logic via dynamic import not available for private fns)
// Test parse only
const msg =
  '[Tap edit] In the app, find the element with testID "day-hint" and replace the text "Tap to plan" with "". Change only what was tapped.';
const parsed = parseTapEditRequest(msg);
console.log("parsed", parsed);

const msg2 =
  '[Tap edit] In the app, find the element with testID "browse-label" and replace the text "Browse Recipes" with "Find Recipes". Change only what was tapped.';
console.log("parsed2", parseTapEditRequest(msg2));

// Quick regex check for JSX replace
const slice = hintSource;
const oldText = "Tap to plan";
const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`\\{\\s*["']${escaped}["']\\s*\\}`, "gu");
const patched = slice.replace(re, '{""}');
console.log("jsx patch", patched);
