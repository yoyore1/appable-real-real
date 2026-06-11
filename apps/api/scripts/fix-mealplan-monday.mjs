import { readProjectFile, writeProjectFile } from "../src/orchestrator.ts";

const pid = process.env.PROJECT_ID ?? "cmq8w9jk20001tlp0m4sbhx2m";
let src = await readProjectFile(pid, "src/components/MealPlanCard.tsx");

const bad = `{day === 'Mon' ? "Monday" : day}`;
const good = `{day}`;

if (src.includes(bad)) {
  src = src.replace(bad, good);
  await writeProjectFile(pid, "src/components/MealPlanCard.tsx", src);
  console.log("MealPlanCard: use {day} — removed Monday override");
} else {
  console.log("MealPlanCard: already using {day}");
}
