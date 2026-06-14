import { auditTapEditReadiness, formatTapEditAuditReport } from "../src/agent/tapEditAudit.js";
import { probeTapEditSave, formatTapEditProbeReport } from "../src/agent/tapEditProbe.js";

const projectId = process.argv[2];
if (!projectId) {
  console.error("usage: tsx scripts/_check-hygiene.mjs <projectId>");
  process.exit(1);
}

const auditIssues = await auditTapEditReadiness(projectId);
const probe = await probeTapEditSave(projectId);

console.log(`\n=== HYGIENE AUDIT ===`);
console.log(formatTapEditAuditReport(auditIssues));
for (const issue of auditIssues) {
  console.log(`- ${issue.file}:${issue.line} [${issue.kind}] ${issue.snippet}`);
}

console.log(`\n=== SAVE PROBE ===`);
console.log(formatTapEditProbeReport(probe));
