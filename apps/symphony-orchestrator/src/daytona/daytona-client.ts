import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";

import type { DaytonaConfig } from "./models.js";

export const createDaytonaClient = (config: DaytonaConfig): Daytona =>
  new Daytona({
    apiKey: config.apiKey,
    ...(config.apiUrl === undefined ? {} : { apiUrl: config.apiUrl }),
    ...(config.target === undefined ? {} : { target: config.target }),
    _experimental: {
      otelEnabled: false,
    },
  });

export const describeUnknown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const isDaytonaNotFound = (error: unknown): boolean => {
  if (error instanceof DaytonaNotFoundError) {
    return true;
  }
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    return error.statusCode === 404;
  }
  return error instanceof Error && error.message.toLowerCase().includes("not found");
};

export const isStateChangeInProgress = (error: unknown): boolean =>
  error instanceof Error && error.message.toLowerCase().includes("state change in progress");
