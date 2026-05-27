export type SecretScanResult = {
  readonly found: boolean;
  readonly count: number;
};

export type Redactor = {
  readonly redact: (text: string) => string;
  readonly scan: (text: string) => SecretScanResult;
  readonly rejectIfPresent: (text: string) => string | undefined;
};

const secretKeyNames = new Set([
  "apiKey",
  "authToken",
  "clientSecret",
  "password",
  "refreshToken",
  "secret",
  "token",
]);

const collectKnownSecretValues = (value: unknown, output: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKnownSecretValues(entry, output);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.length > 0 && secretKeyNames.has(key)) {
      output.add(entry);
      continue;
    }
    collectKnownSecretValues(entry, output);
  }
};

export const makeRedactor = (values: Iterable<string>): Redactor => {
  const secrets = Array.from(new Set(Array.from(values).filter((value) => value.length > 0)));

  const scan = (text: string): SecretScanResult => {
    const count = secrets.reduce((total, secret) => total + (text.includes(secret) ? 1 : 0), 0);
    return { found: count > 0, count };
  };

  return {
    redact: (text) =>
      secrets.reduce((content, secret) => content.split(secret).join("[redacted]"), text),
    scan,
    rejectIfPresent: (text) => {
      const result = scan(text);
      return result.found ? `text contains ${result.count} registered secret value(s)` : undefined;
    },
  };
};

export const redactorFromConfig = (config: unknown): Redactor => {
  const secrets = new Set<string>();
  collectKnownSecretValues(config, secrets);
  return makeRedactor(secrets);
};
