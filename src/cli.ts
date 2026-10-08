import { run } from "./main.js";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (err?: Error) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") return done();
        if (c === "\u0003") return done(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const controller = new AbortController();
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  controller.abort();
});

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  stderrIsTTY: Boolean(process.stderr.isTTY),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  readStdin,
  promptHidden,
  signal: controller.signal,
});
// Let stdout drain before exiting (large results piped to another process).
process.exitCode = code;
