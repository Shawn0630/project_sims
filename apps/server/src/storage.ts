import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProblemDef } from '@sds/problems';

/**
 * Problem storage — the seam between the API and wherever problem packs live.
 *
 * The four-system architecture keeps ALL problem data (statements, workload
 * profiles, test cases INCLUDING hidden ones) behind this interface on the
 * server. Swapping the JSON files below for Postgres later means writing a
 * second implementation of these three methods — no route or judging code
 * changes.
 */
export interface ProblemStorage {
  listProblems(): Promise<ProblemDef[]>;
  getProblem(id: string): Promise<ProblemDef | null>;
  saveProblem(pack: ProblemDef): Promise<void>;
}

/**
 * Where the JSON packs live. Resolved relative to this source file so it
 * works regardless of the process cwd (tsx runs straight from src/).
 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../data/problems/', import.meta.url));

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** One JSON file per problem pack: data/problems/<id>.json */
export class JsonProblemStorage implements ProblemStorage {
  constructor(private readonly dir: string = DEFAULT_DATA_DIR) {}

  async listProblems(): Promise<ProblemDef[]> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort();
    const packs: ProblemDef[] = [];
    for (const f of files) {
      const raw = await readFile(path.join(this.dir, f), 'utf8');
      packs.push(JSON.parse(raw) as ProblemDef);
    }
    return packs;
  }

  async getProblem(id: string): Promise<ProblemDef | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      const raw = await readFile(path.join(this.dir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as ProblemDef;
    } catch {
      return null;
    }
  }

  async saveProblem(pack: ProblemDef): Promise<void> {
    if (!SAFE_ID.test(pack.id)) throw new Error(`unsafe problem id: ${pack.id}`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      path.join(this.dir, `${pack.id}.json`),
      `${JSON.stringify(pack, null, 2)}\n`,
      'utf8',
    );
  }
}
