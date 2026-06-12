/**
 * Transfer a project to another user by email.
 * Usage: pnpm --filter @appable/api exec tsx scripts/transfer-project.mjs <projectId> <userEmail>
 */
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "@appable/db";

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const projectId = process.argv[2];
const userEmail = process.argv[3];

if (!projectId || !userEmail) {
  console.error("Usage: tsx scripts/transfer-project.mjs <projectId> <userEmail>");
  process.exit(1);
}

const db = getDb();
const project = await db.project.findUnique({
  where: { id: projectId },
  include: { user: true },
});
if (!project) {
  console.error("Project not found:", projectId);
  process.exit(1);
}

const user = await db.user.findUnique({ where: { email: userEmail } });
if (!user) {
  console.error("User not found:", userEmail);
  process.exit(1);
}

await db.project.update({
  where: { id: projectId },
  data: { userId: user.id },
});

console.log(
  `Transferred "${project.name}" (${projectId}) from ${project.user.email} -> ${user.email}`,
);
