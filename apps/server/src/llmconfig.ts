import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Dynamic LLM configuration — switchable model PROFILES, so the author can
 * compare how different models judge the same design without restarting
 * the server.
 *
 * Storage: `apps/server/data/llm-config.json` (gitignored — it holds API
 * keys; local only, never committed):
 *
 *   { profiles: [{ id, name, baseUrl, apiKey, model }],
 *     activeProfileId,
 *     envProfileUserSelectable?: boolean }
 *
 * Built on top of the stored profiles sits ONE built-in entry that is not
 * stored at all: the env profile (id 'env-default', name '.env 配置'),
 * synthesized LIVE from the process env (LLM_BASE_URL / LLM_API_KEY /
 * LLM_MODEL) at every read. It is ALWAYS listed in admin, is READ-ONLY
 * there (no stored copy can be created, edited or deleted — a stored
 * record with the reserved id is ignored on load), and exists so the
 * author always has an uncorruptible fallback: whatever happens to the
 * stored profiles, activating the env entry restores exactly the .env
 * values. The stored config may still point activeProfileId at it, and
 * its userSelectable opt-in is persisted as the dedicated file field
 * `envProfileUserSelectable` (default false) — the only mutable bit.
 *
 * Resolution is PER CALL (the file is read every time), so an admin edit
 * takes effect on the very next evaluation.
 *
 * A profile may carry `userSelectable: true` — the admin explicitly opening
 * that profile to END USERS of the solver app. User-selectable profiles are
 * listed (name + model only, never key or baseUrl) by GET /api/models, and
 * a single evaluation may name one via `profileId` to override the active
 * profile for that call only (resolveProfileForCall). The global active
 * profile never changes because of a user's pick.
 */

export interface LlmProfile {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Admin opt-in: may end users of the solver app pick this profile for
   * their own evaluations? Absent/false = server-side only (the default).
   * For the built-in env profile this field is never set on the profile
   * itself — its opt-in lives in the config file (envProfileUserSelectable)
   * and is composed onto the profile at resolution time.
   */
  userSelectable?: boolean;
}

export interface LlmConfigFile {
  /** Stored (admin-editable) profiles. The built-in env profile is NEVER
   *  among them — it is synthesized at read time (see the header). */
  profiles: LlmProfile[];
  /** May legally be 'env-default' — the built-in env entry is activatable. */
  activeProfileId: string | null;
  /**
   * The ONLY mutable setting of the read-only env profile: may end users
   * pick it for their own evaluations? Default false. It lives here (not
   * on the env profile itself) because the env profile is never stored.
   */
  envProfileUserSelectable?: boolean;
}

export type LlmConfigSource = 'admin-config' | 'env';

export interface ResolvedLlmProfile extends LlmProfile {
  source: LlmConfigSource;
}

export const LLM_CONFIG_FILE = fileURLToPath(
  new URL('../data/llm-config.json', import.meta.url),
);

/** Reserved id of the built-in, read-only env profile. */
export const ENV_PROFILE_ID = 'env-default';
export const ENV_PROFILE_NAME = '.env 配置';

const trimUrl = (u: string) => u.replace(/\/$/, '');

/** The built-in profile, resolved LIVE from env — the pre-profiles behavior. */
export function envProfile(
  env: Record<string, string | undefined> = process.env,
): LlmProfile {
  return {
    id: ENV_PROFILE_ID,
    name: ENV_PROFILE_NAME,
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
    const profiles = parsed.profiles
      .filter(isProfile)
      // The reserved env id is synthesized, never stored: a record with
      // that id inside the file (e.g. a masked copy an old admin build
      // round-tripped back) is ignored — it must never shadow the real
      // .env values with a stale, possibly key-less, copy.
      .filter((p) => p.id !== ENV_PROFILE_ID)
      .map((p) => ({
        ...p,
        apiKey: p.apiKey ?? '',
        baseUrl: trimUrl(p.baseUrl),
      }));
    return {
      profiles,
      activeProfileId:
        typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : null,
      ...(parsed.envProfileUserSelectable === true
        ? { envProfileUserSelectable: true }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function writeConfigFile(cfg: LlmConfigFile): Promise<void> {
  await mkdir(path.dirname(LLM_CONFIG_FILE), { recursive: true });
  await writeFile(LLM_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

/** The env profile as a resolution result: live values + its stored opt-in. */
function resolvedEnvProfile(file: LlmConfigFile | null): ResolvedLlmProfile {
  return {
    ...envProfile(),
    userSelectable: file?.envProfileUserSelectable === true,
    source: 'env',
  };
}

/**
 * The profile evaluation calls use RIGHT NOW. Precedence: when a config
 * file exists, its activeProfileId decides — 'env-default' selects the
 * built-in env profile (source 'env', env values drive calls even though
 * a file exists); otherwise the named stored profile (or the first one).
 * Without a file — or with a file that selects nothing usable — the env
 * profile is the default, exactly as before profiles existed.
 */
export async function resolveActiveProfile(): Promise<ResolvedLlmProfile> {
  const file = await readConfigFile();
  if (file) {
    if (file.activeProfileId === ENV_PROFILE_ID) return resolvedEnvProfile(file);
    if (file.profiles.length > 0) {
      const active =
        file.profiles.find((p) => p.id === file.activeProfileId) ?? file.profiles[0];
      return { ...active, source: 'admin-config' };
    }
  }
  return resolvedEnvProfile(file);
}

/** A profile by id (admin probe endpoints), else the active one. The
 *  built-in env profile resolves by its reserved id like any other. */
export async function resolveProfileById(
  id: string | undefined,
): Promise<ResolvedLlmProfile> {
  if (id === ENV_PROFILE_ID) {
    return resolvedEnvProfile(await readConfigFile());
  }
  if (id) {
    const file = await readConfigFile();
    const found = file?.profiles.find((p) => p.id === id);
    if (found) return { ...found, source: 'admin-config' };
  }
  return resolveActiveProfile();
}

export interface CallProfileResolution {
  profile: ResolvedLlmProfile;
  /** True when this call's profile was explicitly picked by an end user. */
  viaUserChoice: boolean;
}

/**
 * Resolve the profile for ONE evaluation call. A requested profileId is
 * honored only when the admin marked that profile userSelectable (stored
 * profiles via their flag; the built-in env profile via the config file's
 * envProfileUserSelectable) — the per-call override end users get through
 * POST /api/evaluate. An unknown or non-selectable id is silently ignored
 * (the server default applies): the field can never be used to reach a
 * profile the admin did not open up, and it never mutates global config.
 */
export async function resolveProfileForCall(
  profileId: string | undefined,
): Promise<CallProfileResolution> {
  if (profileId) {
    const file = await readConfigFile();
    // The built-in env profile is pickable under the same rule as any
    // profile: only when the admin opted it in (envProfileUserSelectable).
    if (profileId === ENV_PROFILE_ID) {
      if (file?.envProfileUserSelectable === true) {
        return { profile: resolvedEnvProfile(file), viaUserChoice: true };
      }
    } else {
      const found = file?.profiles.find((p) => p.id === profileId);
      if (found && found.userSelectable === true) {
        return { profile: { ...found, source: 'admin-config' }, viaUserChoice: true };
      }
    }
  }
  return { profile: await resolveActiveProfile(), viaUserChoice: false };
}

export interface UserSelectableProfile {
  profileId: string;
  name: string;
  model: string;
  /** True when this profile is also the server's active default. */
  isDefault: boolean;
}

/**
 * What GET /api/models may show end users: admin-opened profiles only,
 * name + model — NO keys and NO baseUrl ever leave the server here. The
 * built-in env profile joins the list when its dedicated opt-in is on.
 */
export async function listUserSelectableProfiles(): Promise<UserSelectableProfile[]> {
  const file = await readConfigFile();
  const active = await resolveActiveProfile();
  const out: UserSelectableProfile[] = (file?.profiles ?? [])
    .filter((p) => p.userSelectable === true)
    .map((p) => ({
      profileId: p.id,
      name: p.name,
      model: p.model,
      isDefault: p.id === active.id,
    }));
  if (file?.envProfileUserSelectable === true) {
    const env = envProfile();
    out.push({
      profileId: env.id,
      name: env.name,
      model: env.model,
      isDefault: active.id === env.id,
    });
  }
  return out;
}

/** Browser-safe rendering of a key: last 4 characters only. */
export function maskKey(apiKey: string): string {
  if (!apiKey) return '';
  return apiKey.length <= 4 ? '••••' : `••••${apiKey.slice(-4)}`;
}

/** The shape GET /api/admin/llm-config returns — keys never leave masked. */
export function maskedProfile(
  p: LlmProfile,
  opts?: { readonly?: boolean; source?: LlmConfigSource },
) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    hasKey: p.apiKey.length > 0,
    keyMasked: maskKey(p.apiKey),
    userSelectable: p.userSelectable === true,
    readonly: opts?.readonly === true,
    source: opts?.source ?? 'admin-config',
  };
}

/**
 * The built-in env entry as the admin list renders it: live env values,
 * masked, flagged read-only, its userSelectable taken from the config
 * file's dedicated field.
 */
export function maskedEnvProfile(file: LlmConfigFile | null) {
  return maskedProfile(
    { ...envProfile(), userSelectable: file?.envProfileUserSelectable === true },
    { readonly: true, source: 'env' },
  );
}
