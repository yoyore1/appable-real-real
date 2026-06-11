import { env } from "../src/env.js";
import OpenAI from "openai";
import { pickModel, completeChat, messageContent, NO_THINKING_BODY } from "../src/models.js";

const question =
  "What are the 2 or 3 main things a user does in the app—like picking recipes, checking off ingredients, or tracking weekly meals?";

const prompt = {
  system: `Write 3 tap-to-answer chips for an app interview question.
Each chip 3-10 words, plain language, directly answers the question.
Output ONLY a JSON array of exactly 3 strings.`,
  user: `App idea: A meal planner that builds my grocery list\n\nQuestion:\n${question}\n\nJSON array:`,
};

async function run(label: string, model: string) {
  const client = new OpenAI({ apiKey: env.deepinfraApiKey, baseURL: env.deepinfraBaseUrl });
  const msg = await completeChat({
    choice: { client, model },
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    maxTokens: 120,
    extraBody: NO_THINKING_BODY,
  });
  console.log(`\n${label}:`, messageContent(msg));
}

await run("Qwen chat", env.modelChat);
await run("Kimi build", env.modelBuild);
await run("Qwen2.5", "Qwen/Qwen2.5-72B-Instruct");
