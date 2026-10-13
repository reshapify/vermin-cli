import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Vermin, VerminError, type Document, type RequestOptions } from "@vermin/sdk";
import { brandMarkdown, documentBody, documentHeader, footer } from "@vermin/sdk/format";
import { KEY_PATTERN, configPath, deleteConfigKey, maskKey, readConfig, resolveKey, writeConfig } from "./config.js";
import { EXIT, UsageError, exitCodeFor, hintFor } from "./errors.js";
import { HELP, VERSION, commandHelp } from "./help.js";

export interface IO {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  stderrIsTTY: boolean;
  stdinIsTTY: boolean;
  /** Reads all of stdin (for `vermin login` with a piped key). */
  readStdin(): Promise<string>;
  /** Prompts on the terminal without echoing (for `vermin login`). */
  promptHidden(question: string): Promise<string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Override for tests. */
  configPath?: string;
}

const GLOBAL_OPTIONS = {
  "api-key": { type: "string" },
  "api-url": { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const satisfies ParseArgsConfig["options"];

type Opts = Record<string, string | boolean | string[] | undefined>;

function parse(args: string[], options: ParseArgsConfig["options"]) {
  try {
    return parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message.replace(/^TypeError \[[A-Z_]+\]: /, ""));
  }
}

function int(v: unknown, flag: string, min = 0): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${flag} must be a whole number${min > 0 ? ` ≥ ${min}` : ""}`);
  return n;
}

function oneOf<T extends string>(v: unknown, flag: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw new UsageError(`--${flag} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

const list = (v: unknown): string[] | undefined =>
  v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean);

const TIME_RANGES = ["day", "week", "month", "year"] as const;
/** Search scrapes results within 45 s; the API gives extract up to 150 s. Wait a little longer unless --timeout says otherwise. */
const SEARCH_TIMEOUT_MS = 75_000;
const EXTRACT_TIMEOUT_MS = 180_000;

const FORMATS = ["markdown", "html", "rawHtml", "text", "links", "screenshot", "screenshotFull", "chunks", "metadata", "brand"] as const;
const TIERS = ["auto", "fetch", "render", "premium"] as const;

class Ctx {
  constructor(
    readonly io: IO,
    readonly opts: Opts,
  ) {}
  get json() {
    return this.opts.json === true;
  }
  out(s: string) {
    this.io.stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  }
  /** Status lines go to stderr so stdout stays pipeable. */
  note(s: string) {
    if (!this.opts.quiet) this.io.stderr.write(`${s}\n`);
  }
  emitJson(v: unknown) {
    this.out(JSON.stringify(v, null, 2));
  }
  async client(): Promise<Vermin> {
    const path = this.io.configPath ?? configPath(this.io.env);
    const config = await readConfig(path);
    const resolved = resolveKey(this.opts["api-key"] as string | undefined, this.io.env, config);
    if (!resolved) throw new VerminError({ code: "missing_api_key", message: "No API key found." });
    return new Vermin({
      apiKey: resolved.key,
      baseUrl: (this.opts["api-url"] as string | undefined) ?? this.io.env.VERMIN_API_URL ?? config.apiUrl,
      timeoutMs: int(this.opts.timeout, "timeout", 1),
      fetch: this.io.fetch,
      headers: { "X-Vermin-Client": `vermin-cli/${VERSION}` },
    });
  }
  get req() {
    return this.io.signal ? { signal: this.io.signal } : undefined;
  }
  /** Request options for a call that may run long and must not be charged twice when retried. */
  slowReq(defaultTimeoutMs: number): RequestOptions {
    const key = randomUUID();
    return {
      ...this.req,
      // SDK 0.2.0 only sends idempotencyKey for scrape and crawl, so set the header too.
      idempotencyKey: key,
      headers: { "Idempotency-Key": key },
      timeoutMs: int(this.opts.timeout, "timeout", 1) ?? defaultTimeoutMs,
    };
  }
}

/** Runs one CLI invocation and returns the process exit code. */
export async function run(argv: string[], io: IO): Promise<number> {
  const [command, ...rest] = argv;
  let ctx: Ctx | undefined;
  try {
    if (!command || command === "help" || command === "-h" || command === "--help") {
      io.stdout.write(rest[0] ? commandHelp(rest[0]) : HELP);
      return EXIT.ok;
    }
    if (command === "-v" || command === "--version" || command === "version") {
      io.stdout.write(`${VERSION}\n`);
      return EXIT.ok;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`Unknown command "${command}". Run \`vermin --help\`.`);
    const { values, positionals } = parse(rest, handler.options);
    ctx = new Ctx(io, values as Opts);
    if (values.help) {
      io.stdout.write(commandHelp(command));
      return EXIT.ok;
    }
    await handler.run(ctx, positionals);
    return EXIT.ok;
  } catch (err) {
    return report(err, io, ctx?.json ?? argv.includes("--json"));
  }
}

function report(err: unknown, io: IO, json: boolean): number {
  const code = exitCodeFor(err);
  if (json) {
    const e =
      err instanceof VerminError
        ? { code: err.code, message: err.message, status: err.status, request_id: err.requestId, retry_after_ms: err.retryAfterMs }
        : { code: err instanceof UsageError ? "usage" : "error", message: (err as Error)?.message ?? String(err) };
    io.stdout.write(`${JSON.stringify({ success: false, error: e, exit_code: code })}\n`);
  }
  const message = err instanceof VerminError ? `${err.code}: ${err.message}` : (err as Error)?.message ?? String(err);
  io.stderr.write(`vermin: ${message}\n`);
  const hint = hintFor(err);
  if (hint) io.stderr.write(`hint: ${hint}\n`);
  if (err instanceof VerminError && err.requestId) io.stderr.write(`request id: ${err.requestId} (0 credits charged)\n`);
  return code;
}

interface Command {
  options: ParseArgsConfig["options"];
  run(ctx: Ctx, positionals: string[]): Promise<void>;
}

function needArg(positionals: string[], what: string, command: string): string {
  const v = positionals[0];
  if (!v) throw new UsageError(`Missing ${what}. Usage: ${commandHelp(command).split("\n")[0]!.replace(/^Usage: /, "")}`);
  if (positionals.length > 1) throw new UsageError(`Unexpected argument "${positionals[1]}".`);
  return v;
}

const scrapeOptions = {
  formats: { type: "string", short: "f", multiple: true },
  tier: { type: "string" },
  "max-age": { type: "string" },
  "wait-for": { type: "string" },
  "full-page": { type: "boolean" },
  "ignore-robots": { type: "boolean" },
  output: { type: "string", short: "o" },
} as const satisfies ParseArgsConfig["options"];

function scrapeParams(o: Opts) {
  const formats = list(o.formats);
  for (const f of formats ?? []) if (!(FORMATS as readonly string[]).includes(f)) throw new UsageError(`Unknown format "${f}". One of: ${FORMATS.join(", ")}`);
  return {
    ...(formats ? { formats: formats as (typeof FORMATS)[number][] } : {}),
    ...(o.tier !== undefined ? { tier: oneOf(o.tier, "tier", TIERS) } : {}),
    ...(o["max-age"] !== undefined ? { maxAge: int(o["max-age"], "max-age") } : {}),
    ...(o["wait-for"] !== undefined ? { waitFor: int(o["wait-for"], "wait-for") } : {}),
    ...(o["full-page"] ? { onlyMainContent: false } : {}),
    ...(o["ignore-robots"] ? { ignoreRobots: true } : {}),
  };
}

function docMarkdown(doc: Document): string {
  const body = documentBody(doc);
  const shots = [doc.screenshot ? `Screenshot: ${doc.screenshot}` : ""].filter(Boolean).join("\n");
  return [documentHeader(doc), body, shots].filter(Boolean).join("\n\n");
}

/** A JSON Schema from --schema: inline JSON, a file path, or "-" for stdin. */
async function readSchema(value: string, io: IO): Promise<Record<string, unknown>> {
  const text = value === "-" ? await io.readStdin() : value.trimStart().startsWith("{") ? value : await readFile(value, "utf8").catch(() => {
    throw new UsageError(`--schema: can't read "${value}". Pass a file, inline JSON, or "-" for stdin.`);
  });
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch {
    throw new UsageError("--schema isn't valid JSON.");
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new UsageError("--schema must be a JSON object (a JSON Schema).");
  return schema as Record<string, unknown>;
}

async function emit(ctx: Ctx, text: string) {
  if (ctx.opts.output) {
    await save(ctx.opts.output as string, text);
    ctx.note(`Saved ${ctx.opts.output}`);
  } else ctx.out(text);
}

async function save(path: string, content: string) {
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`);
}

const COMMANDS: Record<string, Command> = {
  scrape: {
    options: scrapeOptions,
    async run(ctx, pos) {
      const url = needArg(pos, "URL", "scrape");
      const vermin = await ctx.client();
      const r = await vermin.scrape({ url, ...scrapeParams(ctx.opts) }, ctx.req);
      const text = ctx.json ? JSON.stringify(r, null, 2) : docMarkdown(r.data);
      if (ctx.opts.output) {
        await save(ctx.opts.output as string, text);
        ctx.note(`Saved ${ctx.opts.output}`);
      } else ctx.out(text);
      ctx.note(footer(r.creditsUsed, r.requestId, r.data.tier ? `tier: ${r.data.tier}` : undefined));
    },
  },

  map: {
    options: {
      search: { type: "string", short: "s" },
      limit: { type: "string", short: "l" },
      sitemap: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      subdomains: { type: "boolean" },
    },
    async run(ctx, pos) {
      const url = needArg(pos, "URL", "map");
      const o = ctx.opts;
      const vermin = await ctx.client();
      const r = await vermin.map(
        {
          url,
          ...(o.search ? { search: o.search as string } : {}),
          ...(o.limit !== undefined ? { limit: int(o.limit, "limit", 1) } : {}),
          ...(o.sitemap !== undefined ? { sitemap: oneOf(o.sitemap, "sitemap", ["include", "skip", "only"] as const) } : {}),
          ...(list(o.include) ? { includePaths: list(o.include) } : {}),
          ...(list(o.exclude) ? { excludePaths: list(o.exclude) } : {}),
          ...(o.subdomains ? { includeSubdomains: true } : {}),
        },
        ctx.req,
      );
      if (ctx.json) ctx.emitJson(r);
      else ctx.out(r.links.map((l) => l.url).join("\n"));
      ctx.note(footer(r.creditsUsed, r.requestId, `${r.links.length} URLs${r.budgetLimited ? " (stopped at the credit budget)" : ""}`));
    },
  },

  search: {
    options: {
      ...scrapeOptions,
      limit: { type: "string", short: "l" },
      country: { type: "string" },
      language: { type: "string" },
      time: { type: "string" },
      scrape: { type: "boolean" },
    },
    async run(ctx, pos) {
      const query = pos.join(" ").trim();
      if (!query) throw new UsageError(`Missing query. Usage: ${commandHelp("search").split("\n")[0]!.replace(/^Usage: /, "")}`);
      const o = ctx.opts;
      const scrape = o.scrape === true || o.formats !== undefined;
      const vermin = await ctx.client();
      const r = await vermin.search(
        {
          query,
          ...(o.limit !== undefined ? { limit: int(o.limit, "limit", 1) } : {}),
          ...(o.country !== undefined ? { country: o.country as string } : {}),
          ...(o.language !== undefined ? { language: o.language as string } : {}),
          ...(o.time !== undefined ? { timeRange: oneOf(o.time, "time", TIME_RANGES) } : {}),
          ...(scrape ? { scrapeOptions: scrapeParams(o) } : {}),
        },
        ctx.slowReq(SEARCH_TIMEOUT_MS),
      );
      const text = ctx.json
        ? JSON.stringify(r, null, 2)
        : r.results
            .map((h, i) => {
              const lines = [`${h.position ?? i + 1}. ${h.title}`, `   ${h.url}`];
              if (h.snippet) lines.push(`   ${h.snippet}`);
              if (h.document) lines.push("", docMarkdown(h.document));
              return lines.join("\n");
            })
            .join(scrape ? "\n\n---\n\n" : "\n\n");
      await emit(ctx, text || "(no results)");
      const scraped = r.results.filter((h) => h.document).length;
      ctx.note(footer(r.creditsUsed, r.requestId, `${r.results.length} results${scrape ? `, ${scraped} scraped` : ""}`));
    },
  },

  extract: {
    options: {
      prompt: { type: "string", short: "p" },
      schema: { type: "string", short: "s" },
      tier: scrapeOptions.tier,
      "wait-for": scrapeOptions["wait-for"],
      "full-page": scrapeOptions["full-page"],
      "ignore-robots": scrapeOptions["ignore-robots"],
      output: scrapeOptions.output,
    },
    async run(ctx, urls) {
      if (!urls.length) throw new UsageError(`Missing URL. Usage: ${commandHelp("extract").split("\n")[0]!.replace(/^Usage: /, "")}`);
      if (urls.length > 25) throw new UsageError("At most 25 URLs per extract.");
      const o = ctx.opts;
      const prompt = (o.prompt as string | undefined)?.trim();
      const schema = o.schema !== undefined ? await readSchema(o.schema as string, ctx.io) : undefined;
      if (!prompt && !schema) throw new UsageError("Give --prompt, --schema, or both, describing what to extract.");
      const scrapeOpts = scrapeParams(o);
      const vermin = await ctx.client();
      const r = await vermin.extract(
        {
          urls,
          ...(prompt ? { prompt } : {}),
          ...(schema ? { schema } : {}),
          ...(Object.keys(scrapeOpts).length ? { scrapeOptions: scrapeOpts } : {}),
        },
        ctx.slowReq(EXTRACT_TIMEOUT_MS),
      );
      await emit(ctx, JSON.stringify(ctx.json ? r : r.data, null, 2));
      for (const s of r.sources ?? []) if (s.ok === false) ctx.note(`  skipped ${s.url}${"error" in s && s.error ? ` (${s.error})` : ""}`);
      const ok = (r.sources ?? []).filter((s) => s.ok !== false).length;
      ctx.note(footer(r.creditsUsed, r.requestId, `${ok} of ${urls.length} URLs read`));
    },
  },

  brand: {
    options: { "max-age": { type: "string" } },
    async run(ctx, pos) {
      const domain = needArg(pos, "domain", "brand");
      const vermin = await ctx.client();
      const maxAge = int(ctx.opts["max-age"], "max-age");
      const r = await vermin.brand({ domain, ...(maxAge !== undefined ? { maxAge } : {}) }, ctx.req);
      if (ctx.json) ctx.emitJson(r);
      else ctx.out(brandMarkdown(r.data));
      ctx.note(footer(r.creditsUsed, r.requestId, r.cached ? "cached" : undefined));
    },
  },

  crawl: {
    options: {
      ...scrapeOptions,
      limit: { type: "string", short: "l" },
      "max-depth": { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      sitemap: { type: "string" },
      subdomains: { type: "boolean" },
      "no-wait": { type: "boolean" },
    },
    async run(ctx, pos) {
      if (pos[0] === "status" || pos[0] === "cancel") return crawlJob(ctx, pos[0], pos.slice(1));
      const url = needArg(pos, "URL", "crawl");
      const o = ctx.opts;
      const vermin = await ctx.client();
      const job = await vermin.crawl.start(
        {
          url,
          ...(o.limit !== undefined ? { limit: int(o.limit, "limit", 1) } : {}),
          ...(o["max-depth"] !== undefined ? { maxDepth: int(o["max-depth"], "max-depth") } : {}),
          ...(list(o.include) ? { includePaths: list(o.include) } : {}),
          ...(list(o.exclude) ? { excludePaths: list(o.exclude) } : {}),
          ...(o.sitemap !== undefined ? { sitemap: oneOf(o.sitemap, "sitemap", ["include", "skip", "only"] as const) } : {}),
          ...(o.subdomains ? { allowSubdomains: true } : {}),
          ...(Object.keys(scrapeParams(o)).length ? { scrapeOptions: scrapeParams(o) } : {}),
        },
        ctx.req,
      );
      if (o["no-wait"]) {
        if (ctx.json) ctx.emitJson(job);
        else ctx.out(job.id);
        ctx.note(`Crawl started. Follow it with \`vermin crawl status ${job.id}\`.`);
        return;
      }
      ctx.note(`Crawl ${job.id} started (Ctrl-C stops watching; the crawl keeps running).`);
      const dir = o.output as string | undefined;
      if (dir) await mkdir(dir, { recursive: true });
      let pages = 0;
      const used = new Set<string>();
      for await (const ev of vermin.crawl.stream(job.id, { signal: ctx.io.signal })) {
        if (ev.type === "page") {
          pages++;
          const doc = ev.data;
          if (dir) await save(join(dir, fileNameFor(doc.url, used, ctx.json ? "json" : "md")), ctx.json ? JSON.stringify(doc, null, 2) : docMarkdown(doc));
          if (ctx.json) ctx.io.stdout.write(`${JSON.stringify({ type: "page", data: doc })}\n`);
          else if (!dir) ctx.out(`${docMarkdown(doc)}\n\n---\n`);
          else ctx.note(`  ${doc.url}`);
        } else if (ev.type === "done") {
          const s = ev.data;
          if (ctx.json) ctx.io.stdout.write(`${JSON.stringify({ type: "done", data: s })}\n`);
          ctx.note(`Crawl ${s.status}: ${s.completed ?? pages} pages, ${s.failed ?? 0} failed · Credits used: ${s.credits_used ?? 0}`);
          if (s.status === "failed") {
            const msg = typeof s.error === "string" ? s.error : (s.error?.message ?? "Crawl failed");
            throw new CrawlFailed(msg);
          }
        }
      }
    },
  },

  login: {
    options: { "no-verify": { type: "boolean" } },
    async run(ctx) {
      const io = ctx.io;
      let key = (ctx.opts["api-key"] as string | undefined) ?? "";
      if (!key) key = io.stdinIsTTY ? await io.promptHidden("Paste your Vermin API key (input hidden): ") : await io.readStdin();
      key = key.trim();
      if (!KEY_PATTERN.test(key)) throw new UsageError("That doesn't look like a Vermin key (vmn_live_…). Create one at https://vermin.dev/dashboard/api-keys");
      if (!ctx.opts["no-verify"]) await verifyKey(ctx, key);
      const path = io.configPath ?? configPath(io.env);
      await writeConfig(path, { ...(await readConfig(path)), apiKey: key });
      ctx.note(`Saved ${maskKey(key)} to ${path} (readable only by you).`);
      if (io.env.VERMIN_API_KEY) ctx.note("Note: VERMIN_API_KEY is set in this shell and takes precedence over the saved key.");
    },
  },

  logout: {
    options: {},
    async run(ctx) {
      const path = ctx.io.configPath ?? configPath(ctx.io.env);
      ctx.note((await deleteConfigKey(path)) ? `Removed the saved key from ${path}.` : "No saved key.");
    },
  },

  whoami: {
    options: {},
    async run(ctx) {
      const path = ctx.io.configPath ?? configPath(ctx.io.env);
      const resolved = resolveKey(ctx.opts["api-key"] as string | undefined, ctx.io.env, await readConfig(path));
      if (!resolved) throw new VerminError({ code: "missing_api_key", message: "No API key found." });
      const where = { flag: "--api-key", env: "VERMIN_API_KEY", config: path }[resolved.source];
      if (ctx.json) ctx.emitJson({ key: maskKey(resolved.key), source: resolved.source, location: where });
      else ctx.out(`${maskKey(resolved.key)} (from ${where})`);
    },
  },
};

/**
 * Checks a key without spending credits: reading an unknown crawl answers
 * 404 for a valid key (or 403 for one without the `read` permission) and 401
 * for an invalid one.
 */
async function verifyKey(ctx: Ctx, key: string) {
  const vermin = new Vermin({
    apiKey: key,
    baseUrl: (ctx.opts["api-url"] as string | undefined) ?? ctx.io.env.VERMIN_API_URL,
    fetch: ctx.io.fetch,
    maxRetries: 1,
  });
  try {
    await vermin.crawl.get("crawl_vermin_cli_login_check", {}, ctx.req);
  } catch (e) {
    if (e instanceof VerminError && (e.code === "not_found" || e.code === "forbidden")) return;
    throw e;
  }
}

async function crawlJob(ctx: Ctx, action: "status" | "cancel", pos: string[]) {
  const id = needArg(pos, "crawl id", "crawl");
  const vermin = await ctx.client();
  if (action === "cancel") {
    const r = await vermin.crawl.cancel(id, ctx.req);
    if (ctx.json) ctx.emitJson(r);
    else ctx.out(`${r.id} ${r.status}`);
    return;
  }
  const s = await vermin.crawl.get(id, { limit: 100 }, ctx.req);
  if (ctx.json) return ctx.emitJson(s);
  ctx.out(
    [
      `Crawl ${s.id}: ${s.status}`,
      `URL: ${s.url}`,
      `Pages: ${s.completed ?? 0} done, ${s.failed ?? 0} failed${s.total ? ` of ${s.total}` : ""}`,
      `Credits used: ${s.credits_used ?? 0}`,
      ...(s.error ? [`Error: ${typeof s.error === "string" ? s.error : s.error.message}`] : []),
      ...(s.data?.length ? ["", ...s.data.map((d) => `- ${d.url}`)] : []),
      ...(s.next ? ["", "More results: use --json and follow `next`."] : []),
    ].join("\n"),
  );
}

class CrawlFailed extends Error {
  override name = "CrawlFailed";
}

/** A stable, filesystem-safe name for a crawled page, unique within one run. */
export function fileNameFor(url: string, used: Set<string>, ext: "md" | "json" = "md"): string {
  let base: string;
  try {
    const u = new URL(url);
    base = `${u.hostname}${u.pathname}`.replace(/\/+$/, "") || u.hostname;
  } catch {
    base = url;
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 150) || "page";
  let name = `${base}.${ext}`;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}.${ext}`;
  used.add(name);
  return name;
}
