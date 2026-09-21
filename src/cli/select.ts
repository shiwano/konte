import * as readline from "node:readline";

interface SelectChoice {
  value: string;
  label: string;
  description?: string;
}

export function selectPrompt(message: string, choices: SelectChoice[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`${message}\n`);
  choices.forEach((c, i) => {
    process.stdout.write(`  ${i + 1}) ${c.label}${c.description ? ` — ${c.description}` : ""}\n`);
  });
  return new Promise((resolve) => {
    const ask = () => {
      rl.question(`Select [1-${choices.length}]: `, (answer) => {
        const n = Number.parseInt(answer.trim(), 10);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
          rl.close();
          resolve(choices[n - 1]!.value);
        } else {
          ask();
        }
      });
    };
    ask();
  });
}
