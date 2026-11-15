# Fixture boundary

All tests run against mock transports, fixed API contracts or local data. API keys such as `pw_test` and `YOUR_API_KEY_HERE` are intentionally non-production test strings. Repeated-digit key IDs and hashes are synthetic identifiers, not credentials. No API/provider key, personal email address, real customer export or deployment config is needed.

The automation routes and public outbound-webhook vocabulary were extracted from the upstream source snapshot and stored in `contracts/service-contract.json`. They describe the contract at that point in time. Tests compare the SDK to that fixed contract; they do not certify a running backend or follow backend changes automatically. The source checksums make the extraction traceable without including an unsupported-language implementation.

The OpenAPI surface in `contracts/openapi.yaml` is the small curated API contract used by the existing SDK generator. All ordinary SDK behavioral tests are retained. Two cross-repository parity tests consume these exported contract records instead of reading a backend source file outside the upload.

## Contact and credential examples

`tests/fixture-data.ts` creates reserved-domain contacts at runtime and returns
clearly marked TEST-ONLY values for credential-bearing mock payloads. The values
have no corresponding accounts or provider access. Repeated-character identifiers
remain synthetic format-validation fixtures. Credential-rejection URL tests build
the invalid URL locally from dummy parts and never send it over a network.

The provider cleanup action constant is an action identifier, not an API key.
Its mock payload retains the exact provider action vocabulary.

Contact-containing OpenAPI example annotations were removed; schemas, required
fields, operations and validation formats are unchanged. Generated types are
regenerated from this local contract. Documentation examples construct a contact
on a reserved example domain. These changes reduce misleading static-upload
warnings while retaining email normalization and request-payload test coverage.
