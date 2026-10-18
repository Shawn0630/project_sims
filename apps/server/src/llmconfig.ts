import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Dynamic LLM configuration — switchable model PROFILES, so the author can
 * compare how different models judge the same design without touching env
 * or restarting the server.
 *
 * Storage: `apps/server/data/llm-config.json` (gitignored — it holds API
 * keys; local only, never committed):
 *
 *   { profiles: [{ id, name, baseUrl, apiKey, model }], activeProfileId }
 *
 * When that file does not exist, a single implicit profile is synthesized
 * from the process env (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL) and labeled
 * 'env 默认' — behavior identical to the original env-only setup.
 *
 * Resolution is PER CALL (resolveActiveProfile reads the file every time),
 * so an admin edit takes effect on the very next evaluation.
 */

export interface LlmProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmConfigFile {
  profiles: LlmProfile[];
  activeProfileId: string | null;
}

export type LlmConfigSource = 'admin-config' | 'env';

export interface ResolvedLlmProfile extends LlmProfile {
  source: LlmConfigSource;
}

export const LLM_CONFIG_FILE = fileURLToPath(
  new URL('../data/llm-config.json', import.meta.url),
);

const trimUrl = (u: string) => u.replace(/\/$/, '');

/** The implicit profile built from env — the pre-profiles behavior. */
export function envProfile(
  env: Record<string, string | undefined> = process.env,
): LlmProfile {
  return {
    id: 'env-default',
    name: 'env 默认',
    baseUrl: trimUrl(env.LLM_BASE_URL ?? 'https://api.openai.com/v1'),
    apiKey: env.LLM_API_KEY ?? '',
    model: env.LLM_MODEL ?? 'gpt-4o-mini',
  };
}

function isProfile(v: unknown): v is LlmProfile {
  const p = v as LlmProfile | null;
  return (
    !!p &&
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.baseUrl === 'string' &&
    typeof p.model === 'string' &&
    (p.apiKey === undefined || typeof p.apiKey === 'string')
  );
}

/** The stored config file, or null when absent/corrupt (→ env fallback). */
export async function readConfigFile(): Promise<LlmConfigFile | null> {
  try {
    const raw = await readFile(LLM_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LlmConfigFile> | null;
    if (!parsed || !Array.isArray(parsed.profiles)) return null;
    const profiles = parsed.profiles.filter(isProfile).map((p) => ({
      ...p,
      apiKey: p.apiKey ?? '',
      baseUrl: trimUrl(p.baseUrl),
    }));
    return {
      profiles,
      activeProfileId:
        typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : null,
    };
  } catch {
    return null;
  }
}

export async function writeConfigFile(cfg: LlmConfigFile): Promise<void> {
  await mkdir(path.dirname(LLM_CONFIG_FILE), { recursive: true });
  await writeFile(LLM_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/**
 * The profile evaluation calls use RIGHT NOW: the file's active profile
 * when a config file exists, otherwise the env profile.
 */
export async function resolveActiveProfile(): Promise<ResolvedLlmProfile> {
  const file = await readConfigFile();
  if (file && file.profiles.length > 0) {
    const active =
      file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0];
    return { ...active, source: 'admin-config' };
  }
  return { ...envProfile(), source: 'env' };
}

/** A stored profile by id (admin probe endpoints), else the active one. */
export async function resolveProfileById(
  id: string | undefined,
): Promise<ResolvedLlmProfile> {
  if (id) {
    const file = await readConfigFile();
    const found = file?.profiles.find((p) => p.id === id);
    if (found) return { ...found, source: 'admin-config' };
  }
  return resolveActiveProfile();
}

/** Browser-safe rendering of a key: last 4 characters only. */
export function maskKey(apiKey: string): string {
  if (!apiKey) return '';
  return apiKey.length <= 4 ? '••••' : `••••${apiKey.slice(-4)}`;
}

/** The shape GET /api/admin/llm-config returns — keys never leave masked. */
export function maskedProfile(p: LlmProfile) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: p.apiKey.length > 0,
    keyMasked: maskKey(p.apiKey),
  };
}
