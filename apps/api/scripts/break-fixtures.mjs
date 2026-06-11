/** Known break patterns applied to a freshly-built GymStreak-style app. */

export async function applyFixture(projectId, name, io) {
  const { readProjectFile, writeProjectFile, listProjectFiles } = io;

  if (name === "easy") {
    const app = await readProjectFile(projectId, "App.tsx");
    await writeProjectFile(
      projectId,
      "App.tsx",
      `${app}\n// BREAK_EASY\nconst __broken = (;\n`,
    );
    return;
  }

  if (name === "medium") {
    const files = await listProjectFiles(projectId);
    const screen = files.find((f) => /screens\/.*Screen\.tsx$/i.test(f) && !f.includes("NonExistent"));
    let app = await readProjectFile(projectId, "App.tsx");
    const importReplaced = app.replace(
      /from\s+['"]\.\/src\/screens\/([^'"]+)['"]/,
      "from './src/screens/NonExistentScreenBroken'",
    );
    if (importReplaced !== app) {
      app = importReplaced;
    } else if (!screen) {
      // Monolith App.tsx — bad screen import referenced at module scope so Metro must resolve it.
      app = app.replace(
        /import AsyncStorage from '@react-native-async-storage\/async-storage';/,
        "import AsyncStorage from '@react-native-async-storage/async-storage';\nimport __mediumBreak from './src/screens/NonExistentScreenBroken';",
      );
      app = app.replace(
        /export default function App\(\)/,
        "void __mediumBreak;\nexport default function App()",
      );
    } else {
      app = `${app}\nimport __mediumBreak from './src/screens/NonExistentScreenBroken';\n`;
    }
    await writeProjectFile(projectId, "App.tsx", app);
    if (screen) {
      const content = await readProjectFile(projectId, screen);
      await writeProjectFile(
        projectId,
        screen,
        content.replace(/export default function (\w+)/, "export default function $1Broken"),
      );
    }
    return;
  }

  if (name === "hard") {
    const files = await listProjectFiles(projectId);
    const storage = files.find((f) => /storage\.ts$/i.test(f));
    const home = files.find((f) => /screens\/.*Home.*\.tsx$/i.test(f));
    if (storage) {
      const content = await readProjectFile(projectId, storage);
      await writeProjectFile(
        projectId,
        storage,
        content.replace(/@appable:habits/g, "@appable:habits_broken_key"),
      );
    }
    if (home) {
      const content = await readProjectFile(projectId, home);
      await writeProjectFile(
        projectId,
        home,
        content.replace(/habit\.name/g, "habit.nonexistentField"),
      );
    }
    const app = await readProjectFile(projectId, "App.tsx");
    let broken = app
      .replace(/case 'home':/gi, "case 'home_broken':")
      .replace(/currentScreen === 'home'/g, "currentScreen === 'home_broken'");
    // Monolith apps (single App.tsx): no separate storage/Home files — break in place.
    if (!storage && !home) {
      broken = broken
        .replace(
          /@react-native-async-storage\/async-storage/,
          "@react-native-async-storage/async-storage-DOES-NOT-EXIST",
        )
        .replace(/STORAGE_KEY = '[^']+'/, "STORAGE_KEY = 'gymstreak_data_broken'")
        .replace(/habit\.name/g, "habit.nonexistentField");
    }
    await writeProjectFile(projectId, "App.tsx", broken);
    return;
  }

  throw new Error(`Unknown fixture: ${name}`);
}
