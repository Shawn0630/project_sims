import { PROBLEMS } from '@sds/problems';
import { JsonProblemStorage } from '../src/storage';

/**
 * Seed storage from the built-in problem definitions: export each
 * ProblemDef from @sds/problems into data/problems/<id>.json. After this,
 * the JSON files are the source of truth the server serves — the problems
 * package remains in the repo as the authoring format (and as the input a
 * future problem generator will imitate).
 */
const storage = new JsonProblemStorage();
for (const pack of PROBLEMS) {
  await storage.saveProblem(pack);
  console.log(
    `seeded ${pack.id} (${pack.testCases.length} cases, ${pack.testCases.filter((t) => t.hidden).length} hidden)`,
  );
}
