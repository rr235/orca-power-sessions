# Code structure

The code is grouped by what it does:

- `src/worker.ts` registers the request handlers; `src/panel.tsx` holds the panel's setup and root.
- `src/protocol.ts` is the contract between them; `src/shared.ts` holds the pure helpers both use.
- `src/orca/` reaches Orca; `src/sessions/` and `src/actions/` are the worker side of sessions and quick actions; `src/panel/` holds the panel's state and components.

## Rules

Four rules, guarded by `src/structure.test.ts`:

1. Only `src/orca/` knows how to reach Orca: its CLI, runtime client and files. `gh`, `lsof` and `ps` run through `src/cli.ts` from the feature that needs them.
2. `src/sessions/` and `src/actions/` never import each other; `src/worker.ts` composes them.
3. Panel code imports only `orca`, `src/protocol.ts`, `src/shared.ts` and itself.
4. One name: quick action.

## Where new code goes

A new Orca call goes in `src/orca/`. A new request is a type in `src/protocol.ts` plus one handler line in `src/worker.ts`.
