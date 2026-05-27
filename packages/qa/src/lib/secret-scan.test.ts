import { makeRedactor } from "../../../../apps/symphony-orchestrator/src/secrets/redactor.js";

export type SecretScanner = {
  readonly scan: (label: string, content: string) => void;
  readonly redact: (content: string) => string;
};

export const makeSecretScanner = (secrets: readonly (string | undefined)[]): SecretScanner => {
  const redactor = makeRedactor(secrets.filter((secret): secret is string => secret !== undefined));
  return {
    scan: (label, content) => {
      const result = redactor.scan(content);
      if (result.found) {
        throw new Error(`${label} contains ${result.count} registered secret value(s)`);
      }
    },
    redact: (content) => redactor.redact(content),
  };
};
