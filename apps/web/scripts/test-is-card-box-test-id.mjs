// Pure logic test for the build-UI's isCardBoxTestId helper. Mirrors the
// regex source in apps/web/src/screens/Build.tsx so we can lock the
// behavior without setting up a full vitest harness. Run with:
//   node apps/web/scripts/test-is-card-box-test-id.mjs
function isCardBoxTestId(id) {
  if (!id) return false;
  if (/(?:^|-)(value|label|name|text|desc|message|header|icon|chevron|tagline|built|version|toggle|input)$/.test(id)) {
    return true;
  }
  if (/(?:^|-)(stat|goal|session|recent-session|card|empty|loading|error|add|view-all|cancel|save|tips|row)(-|$)/.test(id)) {
    if (/(?:^|-)(stats|list|group|title|quick-title|quick-list|screen)$/.test(id)) return false;
    return true;
  }
  return false;
}

const CARDS = [
  "home-stat-total",
  "home-stat-total-value",
  "home-stat-total-label",
  "home-stat-best",
  "home-stat-today",
  "home-add-habit",
  "home-view-all",
  "home-view-all-text",
  "home-empty",
  "home-error",
  "home-loading",
  "add-habit-cancel",
  "add-habit-cancel-label",
  "add-habit-save",
  "add-habit-tips-1",
  "add-habit-tips-2",
  "add-habit-tips-3",
  "add-habit-name-label",
  "add-habit-name-input",
  "settings-notif-row",
  "settings-theme-row",
  "settings-notif-toggle",
  "settings-tagline-text",
  // Quick-list rows must end in -row to be classified as cards (was a mislabel).
  // The build UI sees the resolved value (the template literal is interpolated
  // before postMessage crosses the iframe boundary).
  "home-habit-abc-row",
  "habits-habit-xyz-row",
];

const NON_CARDS = [
  null,
  undefined,
  "",
  "home-stats",
  "home-quick-list",
  "home-quick-title",
  "add-habit-name-group",
  "add-habit-desc-group",
  "add-habit-tips-title",
  "home-screen",
  "settings-screen",
  "add-habit-screen",
  // Quick-list rows WITHOUT -row suffix are mislabeled (was a real bug):
  "home-habit-abc",
];

let failures = 0;
for (const id of CARDS) {
  const got = isCardBoxTestId(id);
  if (got !== true) {
    console.log(`FAIL: card "${id}" got ${got}, want true`);
    failures++;
  }
}
for (const id of NON_CARDS) {
  const got = isCardBoxTestId(id);
  if (got !== false) {
    console.log(`FAIL: non-card ${JSON.stringify(id)} got ${got}, want false`);
    failures++;
  }
}
const total = CARDS.length + NON_CARDS.length;
if (failures === 0) console.log(`OK: ${total}/${total} isCardBoxTestId cases pass`);
else console.log(`${total - failures}/${total} pass, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
