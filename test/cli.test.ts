import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT } from "../src/errors";
import { fileNameFor, run, type IO } from "../src/main";
import { configPath } from "../src/config";

const KEY = "vmn_live_testtesttesttest1234";
const OTHER = "vmn_live_otherotherotherother99";

type Handler = (req: Request) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const apiError = (status: number, code: string, message = code, extra: Record<string, unknown> = {}) =>
  json({ success: false, error: { code, message, ...extra }, credits_used: 0, request_id: "req_err" }, status);

const DOC = { url: "https://example.com/", tier: "fetch", markdown: "# Example Domain\n\nHello.", metadata: { title: "Example Domain", statusCode: 200 } };

async function harness(routes: Record<string, Handler>, opts: { env?: Record<string, string>; stdin?: string; tty?: boolean; config?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vermin-cli-"));
  const calls: Request[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.clone());
    const u = new URL(req.url);
    const h = routes[`${req.method} ${u.pathname}`];
    return h ? h(req) : apiError(404, "not_found", `no route ${req.method} ${u.pathname}`);
  }) as typeof fetch;
  const io: IO = {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    env: { VERMIN_API_KEY: KEY, VERMIN_API_URL: "https://api.test", ...opts.env },
    stderrIsTTY: false,
    stdinIsTTY: opts.tty ?? false,
    readStdin: async () => opts.stdin ?? "",
    promptHidden: async () => opts.stdin ?? "",
    fetch: fetchImpl,
    configPath: opts.config ?? join(dir, "config.json"),
  };
  const exec = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await run(argv, io);
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  return { exec, calls, dir, io };
}

describe("help and usage", () => {
  it("prints help and version", async () => {
    const h = await harness({});
    const help = await h.exec("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: vermin <command>");
    expect((await h.exec("scrape", "--help")).stdout).toContain("Usage: vermin scrape <url>");
    expect((await h.exec("--version")).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("exits 2 on bad usage without calling the API", async () => {
    const h = await harness({});
    expect((await h.exec("nope")).code).toBe(EXIT.usage);
    expect((await h.exec("scrape")).code).toBe(EXIT.usage);
    expect((await h.exec("scrape", "https://a.dev", "--bogus")).code).toBe(EXIT.usage);
    expect((await h.exec("scrape", "https://a.dev", "-f", "pdf")).code).toBe(EXIT.usage);
    expect((await h.exec("map", "https://a.dev", "--limit", "0")).code).toBe(EXIT.usage);
    expect(h.calls).toHaveLength(0);
  });
});

describe("scrape", () => {
  it("prints markdown on stdout and credits on stderr, sending the key and client header", async () => {
    const h = await harness({ "POST /v1/scrape": () => json({ success: true, data: DOC, credits_used: 1, request_id: "req_1" }) });
    const r = await h.exec("scrape", "https://example.com", "-f", "markdown,links", "--tier", "render");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# Example Domain");
    expect(r.stdout).toContain("Hello.");
    expect(r.stderr).toContain("Credits used: 1 · Request ID: req_1");
    const req = h.calls[0]!;
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req.headers.get("x-vermin-client")).toMatch(/^vermin-cli\//);
    expect(await req.json()).toEqual({ url: "https://example.com", formats: ["markdown", "links"], tier: "render" });
  });

  it("prints JSON with --json and writes files with -o; --quiet silences stderr", async () => {
    const h = await harness({ "POST /v1/scrape": () => json({ success: true, data: DOC, credits_used: 1, request_id: "req_1" }) });
    const r = await h.exec("scrape", "https://example.com", "--json", "-q");
    expect(JSON.parse(r.stdout)).toMatchObject({ success: true, data: { url: "https://example.com/" }, creditsUsed: 1 });
    expect(r.stderr).toBe("");
    const file = join(h.dir, "out.md");
    await h.exec("scrape", "https://example.com", "-o", file);
    expect(await readFile(file, "utf8")).toContain("# Example Domain");
  });
});

describe("map and brand", () => {
  it("lists URLs one per line", async () => {
    const h = await harness({
      "POST /v1/map": () => json({ success: true, links: [{ url: "https://a.dev/" }, { url: "https://a.dev/b" }], credits_used: 3, request_id: "r" }),
    });
    const r = await h.exec("map", "https://a.dev", "--search", "docs", "--include", "/b/**,/c/**", "--limit", "5");
    expect(r.stdout).toBe("https://a.dev/\nhttps://a.dev/b\n");
    expect(r.stderr).toContain("2 URLs");
    expect(await h.calls[0]!.json()).toEqual({ url: "https://a.dev", search: "docs", limit: 5, includePaths: ["/b/**", "/c/**"] });
  });

  it("renders a brand", async () => {
    const h = await harness({
      "GET /v1/brand": () => json({ success: true, data: { name: "Acme", domain: "acme.com", colors: [{ hex: "#ff0000" }] }, cached: true, credits_used: 1, request_id: "r" }),
    });
    const r = await h.exec("brand", "acme.com");
    expect(r.stdout).toContain("**Acme** (acme.com)");
    expect(r.stderr).toContain("cached");
    expect(new URL(h.calls[0]!.url).searchParams.get("domain")).toBe("acme.com");
  });
});

const sse = (events: Array<{ event: string; data: unknown; id?: string }>) =>
  new Response(events.map((e) => `${e.id ? `id: ${e.id}\n` : ""}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("crawl", () => {
  const routes = {
    "POST /v1/crawl": () => json({ id: "crawl_1", status: "queued", url: "https://a.dev", createdAt: "2026-10-08T00:00:00Z", credits_used: 0, request_id: "r" }, 202),
    "GET /v1/crawl/crawl_1/events": () =>
      sse([
        { event: "page", id: "1", data: { url: "https://a.dev/", markdown: "# Home" } },
        { event: "page", id: "2", data: { url: "https://a.dev/docs/x", markdown: "# X" } },
        { event: "done", id: "3", data: { id: "crawl_1", status: "completed", url: "https://a.dev", createdAt: "x", completed: 2, failed: 0, credits_used: 2 } },
      ]),
  };

  it("streams pages as NDJSON with --json", async () => {
    const h = await harness(routes);
    const r = await h.exec("crawl", "https://a.dev", "--json", "--limit", "10");
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["page", "page", "done"]);
    expect(r.stderr).toContain("Crawl completed: 2 pages, 0 failed · Credits used: 2");
  });

  it("writes one file per page with -o", async () => {
    const h = await harness(routes);
    const dir = join(h.dir, "site");
    await h.exec("crawl", "https://a.dev", "-o", dir);
    expect((await readdir(dir)).sort()).toEqual(["a.dev.md", "a.dev_docs_x.md"]);
  });

  it("--no-wait prints the id; status and cancel work", async () => {
    const h = await harness({
      ...routes,
      "GET /v1/crawl/crawl_1": () =>
        json({ id: "crawl_1", status: "running", url: "https://a.dev", createdAt: "x", completed: 1, failed: 0, credits_used: 1, data: [{ url: "https://a.dev/" }], next: null }),
      "DELETE /v1/crawl/crawl_1": () => json({ id: "crawl_1", status: "cancelled", url: "https://a.dev", createdAt: "x" }),
    });
    expect((await h.exec("crawl", "https://a.dev", "--no-wait")).stdout).toBe("crawl_1\n");
    const s = await h.exec("crawl", "status", "crawl_1");
    expect(s.stdout).toContain("Crawl crawl_1: running");
    expect(s.stdout).toContain("- https://a.dev/");
    expect((await h.exec("crawl", "cancel", "crawl_1")).stdout).toBe("crawl_1 cancelled\n");
  });
});

describe("errors and exit codes", () => {
  const cases: Array<[string, Response, number, RegExp]> = [
    ["unauthorized", apiError(401, "unauthorized"), EXIT.auth, /vermin login/],
    ["forbidden", apiError(403, "forbidden", "lacks `run`"), EXIT.auth, /restricted/],
    ["insufficient_credits", apiError(402, "insufficient_credits", "No credits"), EXIT.credits, /billing/],
    ["key budget", apiError(402, "insufficient_credits", "budget of 5 credits per day"), EXIT.credits, /api-keys/],
    ["rate_limited", apiError(429, "rate_limited", "slow down", { retry_after_ms: 1 }), EXIT.retry, /Retry in 1s/],
    ["blocked_by_site", apiError(502, "blocked_by_site", "blocked", { retry_after_ms: 1 }), EXIT.target, /tier render/],
  ];
  for (const [name, res, code, hint] of cases) {
    it(`${name} → exit ${code} with a hint`, async () => {
      const h = await harness({ "POST /v1/scrape": () => res.clone() });
      const r = await h.exec("scrape", "https://a.dev");
      expect(r.code).toBe(code);
      expect(r.stderr).toMatch(hint);
      expect(r.stderr).toContain("0 credits charged");
    });
  }

  it("--json prints a machine-readable error on stdout", async () => {
    const h = await harness({ "POST /v1/scrape": () => apiError(401, "unauthorized") });
    const r = await h.exec("scrape", "https://a.dev", "--json");
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error: { code: "unauthorized" }, exit_code: EXIT.auth });
  });

  it("missing key exits 3 without a request", async () => {
    const h = await harness({}, { env: { VERMIN_API_KEY: "" } });
    const r = await h.exec("scrape", "https://a.dev");
    expect(r.code).toBe(EXIT.auth);
    expect(r.stderr).toContain("vermin login");
    expect(h.calls).toHaveLength(0);
  });
});

describe("login, whoami, logout", () => {
  const check = { "GET /v1/crawl/crawl_vermin_cli_login_check": () => apiError(404, "not_found") };

  it("verifies a piped key for free, saves it 0600, and uses it", async () => {
    const h = await harness(check, { env: { VERMIN_API_KEY: "" }, stdin: `${OTHER}\n` });
    const r = await h.exec("login");
    expect(r.code).toBe(0);
    expect(h.calls[0]!.headers.get("authorization")).toBe(`Bearer ${OTHER}`);
    const path = h.io.configPath!;
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ apiKey: OTHER });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const who = await h.exec("whoami");
    expect(who.stdout).toContain("vmn_live_othe…er99");
    expect(who.stdout).not.toContain(OTHER);
    await h.exec("logout");
    expect((await h.exec("whoami")).code).toBe(EXIT.auth);
  });

  it("refuses malformed and invalid keys", async () => {
    const bad = await harness(check, { stdin: "sk-nope" });
    expect((await bad.exec("login")).code).toBe(EXIT.usage);
    const invalid = await harness({ "GET /v1/crawl/crawl_vermin_cli_login_check": () => apiError(401, "unauthorized") }, { stdin: OTHER });
    expect((await invalid.exec("login")).code).toBe(EXIT.auth);
  });

  it("prefers --api-key, then VERMIN_API_KEY, then the saved key", async () => {
    const h = await harness({ "POST /v1/scrape": () => json({ success: true, data: DOC, credits_used: 1 }) });
    await h.exec("login", "--no-verify", "--api-key", OTHER);
    await h.exec("scrape", "https://a.dev");
    expect(h.calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    h.io.env.VERMIN_API_KEY = "";
    await h.exec("scrape", "https://a.dev");
    expect(h.calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${OTHER}`);
  });
});

describe("helpers", () => {
  it("names crawl files safely and uniquely", () => {
    const used = new Set<string>();
    expect(fileNameFor("https://a.dev/docs/x?y=1", used)).toBe("a.dev_docs_x.md");
    expect(fileNameFor("https://a.dev/docs/x", used)).toBe("a.dev_docs_x-2.md");
    expect(fileNameFor("https://a.dev/", used, "json")).toBe("a.dev.json");
  });

  it("finds the config file per platform", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/vermin/config.json");
    expect(configPath({}, "darwin", "/Users/u")).toBe("/Users/u/.config/vermin/config.json");
    expect(configPath({ APPDATA: "C:\\A" }, "win32", "C:\\U")).toContain("vermin");
    expect(configPath({ VERMIN_CONFIG: "/c.json" }, "linux")).toBe("/c.json");
  });
});
