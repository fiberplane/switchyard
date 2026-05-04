import { join } from "node:path";

import { Context, Layer } from "effect";

export type ArtifactStoreShape = {
  readonly runDir: (issueId: string, attempt: number) => string;
};

export class ArtifactStore extends Context.Tag("ArtifactStore")<
  ArtifactStore,
  ArtifactStoreShape
>() {}

const makeArtifactStore = (basePath: string): ArtifactStoreShape => ({
  runDir: (issueId, attempt) => join(basePath, "runs", issueId, String(attempt)),
});

export const ArtifactStoreLive = (basePath: string) =>
  Layer.succeed(ArtifactStore, makeArtifactStore(basePath));
