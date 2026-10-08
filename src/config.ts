import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const KEY_PATTERN = /^vmn_live_[0-9A-Za-z]{16,128}$/;

export interface Config {
  apiKey?: string;
  apiUrl?: string;
}

/** `$XDG_CONFIG_HOME/vermin/config.json`, `~/.config/vermin/config.json`, or `%APPDATA%\vermin\config.json`. */
export function configPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.VERMIN_CONFIG) return env.VERMIN_CONFIG;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "vermin", "config.json");
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "vermin", "config.json");
}

export async function readConfig(path: string): Promise<Config> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const c = parsed as Record<string, unknown>;
    return {
      ...(typeof c.apiKey === "string" ? { apiKey: c.apiKey } : {}),
      ...(typeof c.apiUrl === "string" ? { apiUrl: c.apiUrl } : {}),
    };
  } catch {
    return {};
  }
}

/** Writes the config readable only by the current user (0600). */
export async function writeConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function deleteConfigKey(path: string): Promise<boolean> {
  const c = await readConfig(path);
  if (!c.apiKey) return false;
  delete c.apiKey;
  if (Object.keys(c).length === 0) await rm(path, { force: true });
  else await writeConfig(path, c);
  return true;
}

export type KeySource = "flag" | "env" | "config";

/** `--api-key` beats `VERMIN_API_KEY`, which beats the saved config. */
export function resolveKey(flag: string | undefined, env: NodeJS.ProcessEnv, config: Config): { key: string; source: KeySource } | undefined {
  if (flag) return { key: flag, source: "flag" };
  if (env.VERMIN_API_KEY) return { key: env.VERMIN_API_KEY, source: "env" };
  if (config.apiKey) return { key: config.apiKey, source: "config" };
  return undefined;
}

export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 13)}…${key.slice(-4)}` : "…";
}
