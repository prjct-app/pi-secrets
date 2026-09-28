# Contributing

Integration branch is `develop`. Open pull requests against `develop`.

```bash
npm run check
npm test
npm run check:package
```

Do not add `let` in `src/`. A value must never reach a log, a notice, a tool result, a file outside the keychain, or a test fixture on disk. Tests use the in-memory key store in `tests/keys.ts`, never the real keychain.

Pi packages stay peer dependencies. Use public Pi 0.85.1 APIs only.
