import { readProjectFile, writeProjectFile } from "../src/orchestrator.ts";

const pid = process.env.PROJECT_ID ?? "cmq8w9jk20001tlp0m4sbhx2m";
let src = await readProjectFile(pid, "src/screens/HomeScreen.tsx");

const oldQuick = `      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.actionCard}
          onPress={() => onNavigate('ai')}
          testID="quick-action-ai"
        >
          <Text style={styles.actionEmoji}>✨</Text>
          <Text style={styles.actionTitle}>AI Sugges</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionCard, { color: '#e90c0c' }]}
          onPress={() => onNavigate('recipes')}
          testID="quick-action-recipes"
        >
          <Text style={styles.actionEmoji}>📖fj</Text>
          <Text style={styles.actionTitle}>Browse Recipes</Text>
        </TouchableOpacity>
      </View>`;

const newQuick = `      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.actionCard}
          onPress={() => onNavigate('ai')}
          testID="quick-action-ai"
        >
          <View style={styles.actionRow}>
            <Text testID="quick-action-ai-icon" style={styles.actionEmoji}>✨</Text>
            <Text testID="quick-action-ai-label" style={styles.actionTitle}>AI Suggest</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionCard}
          onPress={() => onNavigate('recipes')}
          testID="quick-action-recipes"
        >
          <View style={styles.actionRow}>
            <Text testID="quick-action-recipes-icon" style={styles.actionEmoji}>📖</Text>
            <Text testID="quick-action-recipes-label" style={styles.actionTitle}>Browse Recipes</Text>
          </View>
        </TouchableOpacity>
      </View>`;

if (!src.includes("styles.quickActions")) {
  throw new Error("HomeScreen quickActions block not found");
}

if (src.includes("styles.actionRow")) {
  console.log("Already using row layout — skipping JSX patch");
} else if (src.includes(oldQuick)) {
  src = src.replace(oldQuick, newQuick);
} else {
  throw new Error("Expected quickActions JSX not found — manual fix needed");
}

const oldStyles = `  actionCard: {
    flex: 1,
    backgroundColor: '#4CAF50',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
  },
  actionEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },`;

const newStyles = `  actionCard: {
    flex: 1,
    backgroundColor: '#4CAF50',
    borderRadius: 16,
    padding: 16,
    justifyContent: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionEmoji: {
    fontSize: 28,
  },`;

if (!src.includes("actionRow:")) {
  if (!src.includes(oldStyles)) throw new Error("Expected actionCard styles not found");
  src = src.replace(oldStyles, newStyles);
}

await writeProjectFile(pid, "src/screens/HomeScreen.tsx", src);
console.log("HomeScreen updated: icon beside label (row layout)");
