# Fixture boundary

All tests run against mock transports, fixed API contracts or local data. API keys such as `pw_test` and `YOUR_API_KEY_HERE` are intentionally non-production test strings. Repeated-digit key IDs and hashes are synthetic identifiers, not credentials. No API/provider key, personal email address, real customer export or deployment config is needed.

The automation routes and public outbound-webhook vocabulary were extracted from the upstream source snapshot and stored in `contracts/service-contract.json`. They describe the contract at that point in time. Tests compare the SDK to that fixed contract; they do not certify a running backend or follow backend changes automatically. The source checksums make the extraction traceable without including an unsupported-language implementation.

The OpenAPI surface in `contracts/openapi.yaml` is the small curated API contract used by the existing SDK generator. All ordinary SDK behavioral tests are retained. Two cross-repository parity tests consume these exported contract records instead of reading a backend source file outside the upload.
