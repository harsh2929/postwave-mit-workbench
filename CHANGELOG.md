# Changelog

All notable changes to `@postwave/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added the separate `campaignTemplates` visual-design resource with catalog
  search, CRUD, clone, adapt, generate, and create-campaign-from-template APIs.
- Added explicit `campaignTemplates.favorite()` and `.unfavorite()` helpers for
  authenticated user-private catalog state.

## [0.1.1-workbench] - 2026-11-15

### Changed

- Centralized synthetic contact and credential fixtures without changing SDK
  transport behavior or the timeout/cancellation work remaining to be done.
- Removed optional contact examples from the OpenAPI annotations and regenerated
  type comments; operation schemas and validation constraints are unchanged.
- Strengthened the source upload check against literal contacts and misleading
  credential-shaped examples.

## [0.1.0] - 2026-05-08

Initial public release.
