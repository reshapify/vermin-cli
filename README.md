# Vermin CLI

Turn any website into clean, LLM-ready markdown and brand data from your terminal, scripts or AI agent.

```bash
npx @vermin/cli scrape https://example.com
```

Or install it globally:

```bash
npm i -g @vermin/cli
vermin scrape https://example.com
```

Requires Node.js 18.3 or later.

## Sign in

Create a key at [vermin.dev/dashboard/api-keys](https://vermin.dev/dashboard/api-keys) (free plan, no card), then:

```bash
vermin login              # paste the key (input hidden)
echo "$KEY" | vermin login  # or pipe it in
```

The key is checked against the API (free) and saved to `~/.config/vermin/config.json` (`%APPDATA%\vermin\config.json` on Windows), readable only by you. `VERMIN_API_KEY` takes precedence when set, which is what you want in CI.

## Commands

| Command | What it does | Credits |
| --- | --- | --- |
| `vermin scrape <url>` | One page as markdown (or `-f html,links,chunks,screenshot,…`) | 1, browser included |
| `vermin map <url>` | Every URL on a site, one per line; `--search` ranks them | 3 per 10 fetches |
| `vermin crawl <url>` | Crawl a site and stream every page; `-o dir` writes one file per page | 1 per page |
| `vermin crawl status <id>` / `cancel <id>` | Follow or stop a crawl | free |
| `vermin brand <domain>` | Logo, colours, fonts and socials | 5, 1 cached |
| `vermin login` / `logout` / `whoami` | Manage the saved key | free |

Failed pages always cost 0 credits. Run `vermin <command> --help` for every flag.

```bash
vermin scrape https://docs.example.com/guide -o guide.md
vermin map https://docs.example.com --search "rate limits" --limit 10
vermin crawl https://docs.example.com --limit 200 --include "/guides/**" -o ./docs
vermin brand stripe.com --json | jq .data.colors
```

## For scripts and agents

- **Results on stdout, everything else on stderr.** Credits used, request ids and progress go to stderr, so `vermin scrape … > page.md` captures only the page. `-q` silences stderr.
- **`--json`** prints the full API response. `vermin crawl --json` prints NDJSON: one `{"type":"page",…}` line per page, then `{"type":"done",…}`. Errors print `{"success":false,"error":{…},"exit_code":…}`.
- **Exit codes** you can branch on:

  | Code | Meaning |
  | --- | --- |
  | 0 | Success |
  | 1 | Unexpected error |
  | 2 | Bad command line |
  | 3 | No key, invalid key, or the key lacks the permission |
  | 4 | Out of credits, spend cap reached, or the key's budget is used up |
  | 5 | Rate limited or busy: retry later |
  | 6 | The page couldn't be read (blocked, unreachable, timed out, unsupported) |
  | 7 | Not found (e.g. unknown crawl id) |

- **Least privilege:** give an agent its own key with a credit budget and only the permissions it needs ([docs](https://vermin.dev/docs/authentication)).

## Environment

| Variable | Purpose |
| --- | --- |
| `VERMIN_API_KEY` | API key (beats the saved key) |
| `VERMIN_API_URL` | API base URL (default `https://api.vermin.dev`) |
| `VERMIN_CONFIG` | Config file path |

## Links

[Docs](https://vermin.dev/docs/cli) · [API reference](https://vermin.dev/docs/reference) · [MCP server](https://vermin.dev/docs/mcp) · [TypeScript SDK](https://www.npmjs.com/package/@vermin/sdk)

## License

MIT
