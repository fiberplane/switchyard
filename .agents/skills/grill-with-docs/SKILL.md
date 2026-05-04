---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (docs/patterns, docs/architecture) inline as decisions crystallise. Use when user wants to stress-test a plan against the project's language and documented decisions.
---

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

</what-to-do>

<supporting-info>

## Repo documentation map

`docs/README.md` is the system of record for what goes where. Read it before grilling — it tells you the homes for patterns, templates, and architecture, and the rules for when to put something in each.

The shape relevant to a grill session:

```
/
├── AGENTS.md            ← repo map: apps, packages, commands, pointers into docs/
│                          (CLAUDE.md is a symlink to AGENTS.md)
├── docs/
│   ├── README.md        ← convention guide — read this first
│   ├── patterns/        ← how we write code (effect, boundaries, data-validation,
│   │                      coding-style, observability)
│   ├── templates/       ← how to build things (cli, api, worker)
│   └── architecture/    ← what the system looks like — populated as apps are built
├── rules/               ← ast-grep rules that mechanically enforce patterns
│   ├── shared/
│   └── effect/
├── apps/                ← deployable apps (CLIs, APIs, workers)
└── packages/            ← shared packages
```

There is no `CONTEXT.md`, `docs/adr/`, `docs/proposals/`, or explicit glossary in this repo. The closest analogues for a grill session:

- **Established conventions** ("how we write Effect", "how we structure boundaries") → `docs/patterns/` and the ast-grep rules in `rules/effect/` and `rules/shared/`.
- **How to build a new app** ("CLI scaffold", "HTTP API scaffold") → `docs/templates/`.
- **Settled architectural shape** ("what the system looks like for app X") → `docs/architecture/` (currently empty; populated as apps are built).
- **Repo-level naming** (app names, package names, command names) → the tables in `AGENTS.md`.

Do not create `CONTEXT.md`, `docs/adr/`, or `docs/proposals/`. Update or extend the docs that already exist; only graduate to a new file when `docs/README.md`'s convention says you should.

## During the session

### Challenge against established conventions

When the user's plan conflicts with conventions documented in `docs/patterns/`, the ast-grep rules in `rules/`, settled shape in `docs/architecture/`, or the names/responsibilities recorded in `AGENTS.md`, call it out immediately. Examples:

- "`docs/patterns/effect.md` requires custom errors to extend `Data.TaggedError` (and `rules/effect/use-tagged-error.yml` enforces it). Your plan introduces a plain `Error` subclass — intentional?"
- "`docs/patterns/boundaries.md` says external SDKs are wrapped in adapter files; `runPromise` only appears at entry points. Your plan calls `Effect.runPromise` inside an interior service — is that a deliberate departure?"
- "`docs/patterns/data-validation.md` requires `Schema.decodeUnknown` at boundaries — no `as` casts on parsed data. Your plan has `JSON.parse(body) as Foo` — intentional?"
- "You're using the name 'workspace' for what `AGENTS.md` calls a 'project' — which do you mean?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term grounded in the codebase. "You're saying 'service' — do you mean an Effect `Context.Tag` service, an adapter wrapping an SDK, or a deployable app under `apps/`? Pick the one you mean and use it consistently."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your plan says the adapter swallows network errors, but the existing code in `apps/foo/src/http.adapter.ts` lets them propagate as a tagged error — which is right?"

### Update docs inline

When a convention is sharpened or a name is pinned down, update the relevant doc in place — don't batch. Use the routing in `docs/README.md`:

- **Coding convention** (idiom, rule, style — applies across files) → extend the relevant `docs/patterns/*.md`. If the pattern can be enforced mechanically, mention adding an ast-grep rule under `rules/effect/` or `rules/shared/` (with a matching test under `rule-tests/`).
- **System shape, data flow, or process model** → `docs/architecture/` (create the file if it doesn't exist; this directory starts empty).
- **How to build a new app of some kind** → extend the matching `docs/templates/*.md`.
- **Repo-level names or command pointers** → update `AGENTS.md`.
- **App-specific setup or run instructions** → the app's own `README.md`, *not* `docs/`.

Don't couple docs to implementation details. Capture conventions that survive refactors, not specifics of a single function.

If the doc describes code behavior tightly, bind it with `drift link <doc> <source-file>` so future drift is caught — see `docs/README.md` and the drift skill.

### Capture decisions sparingly

If the decision is already settled and uncontroversial, write it directly into `docs/architecture/` or `docs/patterns/`. Don't invent ceremony where there's no live trade-off.

This repo doesn't have a `docs/proposals/` folder. When a non-obvious architectural decision needs to be recorded, capture it inline in the appropriate `docs/architecture/<topic>.md` with a short rationale section — see [ADR-FORMAT.md](./ADR-FORMAT.md) for the shape and the criteria for when a decision is worth capturing at all.

</supporting-info>
