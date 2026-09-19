import { runAgent } from "./agent.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function main() {
  const userMessage = process.argv.slice(2).join(" ");

  if (!userMessage) {
    console.error("Usage: node src/index.js <your message>");
    process.exit(1);
  }

  const approvalCallback = async ({ tool, args }) => {
    console.log(`\n[Approval Required] ${tool}`);

    if (tool === "write_file") {
      console.log(`Path: ${args.path}`);
      console.log(`Content:\n${args.content}`);
    }

    const answer = await ask("Allow this operation? (y/n): ");

    return answer.trim().toLowerCase() === "y";
  };

  const result = await runAgent(userMessage, { approvalCallback });

  if (result.success) {
    console.log("\n" + result.content);
  } else {
    console.error("\nError:", result.error);
    process.exit(1);
  }
}

async function ask(question) {
  const rl = createInterface({ input, output });

  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

main();
