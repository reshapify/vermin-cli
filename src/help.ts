import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
export const VERSION: string = pkg.version;

export const HELP = `vermin ${VERSION}: clean, LLM-ready web data from your terminal

Usage: vermin <command> [options]

Commands:
  scrape <url>           Read one page as markdown (1 credit, browser included)
  map <url>              List a site's URLs, optionally ranked by --search
  crawl <url>            Crawl a site and stream every page
  crawl status <id>      Show a crawl's progress and pages
  crawl cancel <id>      Stop a crawl
  brand <domain>         Logo, colours, fonts and socials for a company
  login                  Save an API key for this user
  logout                 Remove the saved key
  whoami                 Show which key is in use and where it came from

Global options:
  --json                 Print the full JSON result (errors too) instead of markdown
  -q, --quiet            No status lines on stderr
  --api-key <key>        Use this key (prefer VERMIN_API_KEY or \`vermin login\`)
  --api-url <url>        API base URL (default https://api.vermin.dev)
  --timeout <ms>         Per-request timeout
  -h, --help             Help for a command: vermin <command> --help
  -v, --version          Print the version

Results go to stdout; credits used and progress go to stderr. Failed pages cost 0 credits.
Exit codes: 0 ok, 1 error, 2 usage, 3 auth/permission, 4 credits/budget,
5 rate limited (retry), 6 target page unreadable, 7 not found.

Keys: https://vermin.dev/dashboard/api-keys · Docs: https://vermin.dev/docs/cli
`;

const SCRAPE_FLAGS = `  -f, --formats <list>   markdown,html,rawHtml,text,links,screenshot,screenshotFull,chunks,metadata,brand
  --tier <tier>          auto (default), fetch, render
  --full-page            Keep navs, footers and other boilerplate
  --wait-for <ms>        Wait after the page loads (rendered pages)
  --max-age <ms>         Accept a cached result up to this age (0 = always fresh)
  --ignore-robots        Don't check robots.txt`;

const COMMAND_HELP: Record<string, string> = {
  scrape: `Usage: vermin scrape <url> [options]

Reads one page. Prints markdown with a short header (title, URL, tier).

${SCRAPE_FLAGS}
  -o, --output <file>    Write the result to a file

Examples:
  vermin scrape https://example.com
  vermin scrape https://example.com -f markdown,links --json | jq .data.links
`,
  map: `Usage: vermin map <url> [options]

Lists the URLs on a site, one per line (3 credits per 10 fetches).

  -s, --search <query>   Rank URLs by relevance to a query
  -l, --limit <n>        At most n URLs
  --sitemap <mode>       include (default), skip, only
  --include <glob>       Only paths matching (repeatable or comma-separated)
  --exclude <glob>       Skip paths matching (repeatable or comma-separated)
  --subdomains           Include subdomains

Example:
  vermin map https://docs.example.com --search "authentication" --limit 20
`,
  crawl: `Usage: vermin crawl <url> [options]
       vermin crawl status <id>
       vermin crawl cancel <id>

Crawls a site and streams each page as it's scraped (1 credit per page).

  -l, --limit <n>        At most n pages
  --max-depth <n>        Link depth from the start URL
  --include <glob>       Only paths matching (repeatable or comma-separated)
  --exclude <glob>       Skip paths matching (repeatable or comma-separated)
  --sitemap <mode>       include (default), skip, only
  --subdomains           Follow links to subdomains
  -o, --output <dir>     Write one file per page into <dir>
  --no-wait              Print the crawl id and exit
${SCRAPE_FLAGS}

With --json, prints one JSON object per line (NDJSON): {"type":"page",...} then {"type":"done",...}.

Examples:
  vermin crawl https://docs.example.com --limit 200 --include "/guides/**" -o ./docs
  vermin crawl https://example.com --json | jq -r 'select(.type=="page") | .data.url'
`,
  brand: `Usage: vermin brand <domain> [options]

Brand identity for a company: logo, icon, colours, fonts, socials (5 credits, 1 when cached).

  --max-age <ms>         Accept a cached result up to this age (0 = always fresh)

Example:
  vermin brand stripe.com --json
`,
  login: `Usage: vermin login [--no-verify]

Saves an API key to your config file (readable only by you). Paste it when
asked, or pipe it in: echo "$KEY" | vermin login. The key is checked against the
API first (free) unless --no-verify. VERMIN_API_KEY, when set, takes precedence.
`,
  logout: `Usage: vermin logout

Removes the saved API key.
`,
  whoami: `Usage: vermin whoami

Shows which API key is in use (masked) and where it came from.
`,
};

export function commandHelp(command: string): string {
  return COMMAND_HELP[command] ?? HELP;
}
