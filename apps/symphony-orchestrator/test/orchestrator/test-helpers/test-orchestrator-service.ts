import { Effect, Layer } from "effect";

import { OrchestratorService, type TickResult } from "../../../src/orchestrator/service.js";

export type TestOrchestratorShape = {
  readonly runOneTick: Effect.Effect<TickResult>;
  readonly stop: Effect.Effect<void>;
};

export const TestOrchestratorServiceLive = (service: TestOrchestratorShape) =>
  Layer.succeed(OrchestratorService, {
    runOneTick: service.runOneTick,
    runOne: (issue) =>
      service.runOneTick.pipe(
        // Test helper only: production runOne is covered in service tests.
        // The entrypoint smoke needs a complete OrchestratorService surface.
        Effect.as({
          issueId: issue.detail.id,
          attempt: 1,
          status: "integrated" as const,
          branch: undefined,
          summary: undefined,
          lastError: undefined,
        }),
      ),
    stop: service.stop,
  });
