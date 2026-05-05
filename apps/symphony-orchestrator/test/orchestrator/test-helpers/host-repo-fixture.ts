// Cycle 13b: thin wrapper around the existing integration host-repo fixture
// that adds the orchestrator-side helpers it needs (cwd-rooted git env, base
// rev capture, branch-existence assertion).

import { setupHostRepo, headSha, branchExistsRaw } from "../../integration/test-helpers/host-repo.js";

export type SymphonyHostRepoFixture = {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
  readonly env: Record<string, string | undefined>;
  readonly baseSha: () => Promise<string>;
  readonly branchExists: (name: string) => Promise<boolean>;
};

export const createSymphonyHostRepoFixture = async (): Promise<SymphonyHostRepoFixture> => {
  const repo = await setupHostRepo();
  return {
    dir: repo.dir,
    cleanup: repo.cleanup,
    env: repo.env,
    baseSha: () => headSha(repo.dir),
    branchExists: (name) => branchExistsRaw(repo.dir, name),
  };
};
