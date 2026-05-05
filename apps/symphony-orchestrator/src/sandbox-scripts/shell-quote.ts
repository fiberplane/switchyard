// POSIX-safe single-quote shell escaping. Identical to the pattern used by
// `daytona.adapter.ts` for command-envelope wrapping; lifted here so both
// `setup.ts` and `finalize.ts` can quote without duplicating the helper.
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
