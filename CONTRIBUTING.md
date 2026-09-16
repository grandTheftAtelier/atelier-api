# Contributing to atelier-api

Thanks for your interest! atelier-api is open source under a **noncommercial**
license (see [LICENSE.md](LICENSE.md)) — contributions are welcome for
noncommercial use.

## Ways to contribute

- 🐛 **Bug?** Open an [issue](https://github.com/grandTheftAtelier/atelier-api/issues/new/choose)
  with steps to reproduce.
- ✨ **Idea / feature?** Open an issue to discuss it first, especially for larger
  changes.
- 🔧 **Code?** Fork → branch → pull request (see below).

## Development

Requirements: [Bun](https://bun.sh) and a MongoDB (local or Atlas).

```bash
bun install
cp .env.example .env.local   # fill in MONGODB_URI etc.; dev fake auth is fine
bun run dev                  # http://127.0.0.1:3095
bun run lint                 # tsc --noEmit
bun run smoke                # E2E suite (server must be running, fake mode)
bun run sync-roundtrip       # push/pull roundtrip
```

The full setup (env vars, Discord app, admin dashboard, endpoints) is documented
in the [README](README.md).

## Pull requests

1. Fork the repo and create a branch off `master` (`feat/…`, `fix/…`).
2. Keep the change focused and match the surrounding code style (zero-dependency,
   raw MongoDB driver, no framework).
3. Make sure `bun run lint` passes and the smoke suite still goes green — CI runs
   typecheck + the full smoke/sync suite against a throwaway Mongo, plus a Docker
   build gate.
4. Open a PR against `master`, fill in the template and link any related issue.

A maintainer reviews and merges. Direct pushes to `master` are restricted — all
changes land via a pull request that passes CI.

## License of contributions

By contributing, you agree that your contributions are licensed under the
project's [PolyForm Noncommercial 1.0.0](LICENSE.md) license.
