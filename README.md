# Moosewave TypeScript SDK workbench

This is the existing Moosewave/Postwave TypeScript SDK isolated from the larger application. It includes its client/resources, generated operation types, webhook verification, examples, tests and a small API-contract snapshot. First-party source is MIT-licensed; retain [LICENSE](LICENSE). It is a real client-library codebase, not a new application scaffold.

## Requirements

- Node.js 22.18 or later
- npm
- Python 3 for the read-only bundle check

## Install and verify

```sh
npm ci --ignore-scripts
npm run verify
```

The project npm configuration avoids automatically installing unused optional browser-tooling peers. Verification dependencies are declared and locked.

`verify` runs source linting, TypeScript checks, generated-contract drift checks, mocked unit tests, both module-format export checks, a production library build and the upload-boundary audit. No database, application server, cloud account or real API credential is needed. The suite rejects unmocked network calls.

For a focused run:

```sh
npm test -- tests/webhook.test.ts
npm run typecheck
npm run build
```

See [SDK-REFERENCE.md](SDK-REFERENCE.md) for the original client API, and [FIXTURES.md](FIXTURES.md) for the test-data and pinned-contract boundary. Library examples that target a live service are reference code; they are not run by verification and require credentials supplied by the operator.

## Upload contents

The upload archive contains source, contract fixtures, tests, documentation, manifests, the dependency lock and `.gitignore`. It excludes Git metadata, installed dependencies, build/coverage output, caches, unsupported-language source, assistant instructions, workflows and local configuration.

This package and its fixed contracts support client-library work. They do not include or certify the full application backend, live provider integrations or production deployment. Source history and release checks are recorded outside the upload so the package contains only normal project files.
