import { join } from "node:path";

import { SandboxScriptError } from "../../../src/sandbox-scripts/errors.js";

export type SeededArchive = {
  readonly archivePath: string;
  readonly cleanup: () => Promise<void>;
};

const mkdtemp = async (template: string): Promise<string> =>
  (await Bun.$`mktemp -d ${template}`.text()).trim();

const sh = async (cwd: string, args: readonly string[]): Promise<void> => {
  const proc = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new SandboxScriptError({
      operation: "setupRepo",
      command: args.join(" "),
      exitCode,
      stderr,
    });
  }
};

// Builds a tiny tracked-file fixture as repo.tgz for upload to a sandbox.
// Goal is to verify the sandbox-script contract, not real-world repo size; two
// text files is enough to prove `tar -xzf` + `git init/add/commit` succeeds.
export const seedArchive = async (): Promise<SeededArchive> => {
  const stagingRoot = await mkdtemp("/tmp/swy-sbox-script-archive-XXXXXXXX");
  const stage = join(stagingRoot, "stage");
  await Bun.$`mkdir -p ${stage}`;
  await Bun.write(join(stage, "package.json"), '{"name":"sandbox-fixture","private":true}\n');
  await Bun.write(join(stage, "README.md"), "# sandbox fixture\n");

  const archivePath = join(stagingRoot, "repo.tgz");
  await sh(stage, ["tar", "-czf", archivePath, "package.json", "README.md"]);

  return {
    archivePath,
    cleanup: async () => {
      await Bun.$`rm -rf ${stagingRoot}`;
    },
  };
};
