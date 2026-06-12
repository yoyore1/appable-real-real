import {
  applyTapEditToSource,
  buildTapEditBackgroundMessage,
  buildTapEditColorMessage,
  buildTapEditReplaceMessage,
  probeTapEditRequest,
} from "../src/agent/tapEdit.ts";
import {
  deriveRowTestIdFromLabel,
  expandTemplateTestId,
  parseDataRecords,
} from "../src/agent/tapEditDiscovery.ts";

const SAMPLE = `
import { Pressable, ScrollView, Text } from "react-native";

export default function HomeScreen() {
  return (
    <ScrollView style={styles.screen} testID="home-screen">
      {items.map((item) => (
        <Pressable
          key={item.id}
          style={styles.card}
          testID={\`todo-\${item.id}-row\`}
        >
          <Text testID={\`todo-\${item.id}-title\`} style={styles.title}>
            {item.title}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
`;

const STORAGE = `
export const SEED_ITEMS = [
  { id: "a1", title: "Alpha task" },
  { id: "b2", title: "Beta task" },
];
`;

const sources = new Map([
  ["app/(tabs)/index.tsx", SAMPLE],
  ["src/lib/storage.ts", STORAGE],
]);

const records = parseDataRecords(STORAGE);
const a1TestId = expandTemplateTestId("todo-${item.id}-title", "a1");
const a1RowId = deriveRowTestIdFromLabel(a1TestId);
const text = records.get("a1")?.title ?? "";

const cases = [
  {
    label: "rename a1",
    msg: buildTapEditReplaceMessage(a1TestId, text, "Alphax"),
    expect: /title: "Alphax"/,
    reject: null,
  },
  {
    label: "color a1 only",
    msg: buildTapEditColorMessage(a1TestId, "#ff5500"),
    expect: /item\.id === 'a1' && \{ color: '#ff5500' \}/,
    reject: /item\.id === 'b2'/,
  },
  {
    label: "bg a1 row only",
    msg: buildTapEditBackgroundMessage(a1RowId, "#112233"),
    expect: /item\.id === 'a1' && \{ backgroundColor: '#112233' \}/,
    reject: /item\.id === 'b2'/,
  },
];

let failed = 0;
for (const { label, msg, expect, reject } of cases) {
  const probe = probeTapEditRequest(msg, sources);
  const updated = probe.ok ? applyTapEditToSource(sources.get(probe.file) ?? "", msg) : null;
  const ok =
    probe.ok &&
    Boolean(updated) &&
    expect.test(updated) &&
    !(reject && reject.test(updated));
  console.log(JSON.stringify({ label, ok, file: probe.ok ? probe.file : null }));
  if (!ok) failed++;
}

process.exit(failed > 0 ? 1 : 0);
