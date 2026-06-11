import type { ChatTool } from "../models.js";
import {
  deleteProjectFile,
  execInProject,
  getProjectLogs,
  listProjectFiles,
  readProjectFile,
  verifyApp,
  writeProjectFile,
} from "../orchestrator.js";
import { emit } from "../events.js";

export const agentTools: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the project (node_modules excluded).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path, e.g. App.tsx" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the project with complete content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative path, e.g. src/screens/Home.tsx" },
          content: { type: "string", description: "The complete file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command inside the project container (cwd /app). Use sparingly; prefer file tools.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_build_logs",
      description:
        "Read the last lines of the Metro dev-server logs to check for build/runtime errors.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

const MAX_TOOL_RESULT_CHARS = 12_000;

function clip(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}

/** Execute one tool call against the project container; returns the tool result string. */
export async function executeTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "list_files": {
      const files = await listProjectFiles(projectId);
      return files.join("\n") || "(no files)";
    }
    case "read_file": {
      const content = await readProjectFile(projectId, String(args.path));
      return clip(content);
    }
    case "write_file": {
      const path = String(args.path);
      await writeProjectFile(projectId, path, String(args.content));
      emit(projectId, { type: "file.op", op: "write", path });
      return `Wrote ${path}`;
    }
    case "delete_file": {
      const path = String(args.path);
      await deleteProjectFile(projectId, path);
      emit(projectId, { type: "file.op", op: "delete", path });
      return `Deleted ${path}`;
    }
    case "run_command": {
      const command = String(args.command);
      if (/\bexpo\s+start\b/i.test(command)) {
        return "Metro is already running. Do not start expo again — use read_build_logs, read_file, and write_file.";
      }
      const result = await execInProject(projectId, ["sh", "-c", command], {
        timeoutMs: 60_000,
      });
      return clip(
        `exit code: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    case "read_build_logs": {
      // Force compile + preview smoke so errors actually surface.
      const verifyError = await verifyApp(projectId);
      const logs = await getProjectLogs(projectId, 150);
      const parts = [
        verifyError
          ? `VERIFY ERROR:\n${verifyError}`
          : "App verified — bundle compiles and preview loads.",
        logs ? `Recent logs:\n${logs}` : "(no logs)",
      ];
      return clip(parts.join("\n\n"));
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
