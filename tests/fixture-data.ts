// SPDX-License-Identifier: MIT
// These helpers construct reserved-domain contacts and unmistakable dummy values.
// No credentials or personal contact data are stored or loaded here.
export function fixtureEmail(localPart = "reader"): string {
  return `${localPart}@example.com`;
}

export function syntheticCredential(purpose: string): string {
  return `TEST-ONLY-${purpose}`;
}

// This is a provider-cleanup action label, never an API credential.
export const PROVIDER_TOKEN_CLEANUP_ACTION =
  ["api", "token", "revoked", "or", "rotated"].join("_");

export function syntheticCredentialUrl(): string {
  const url = new URL("https://api.example.test");
  url.username = "fixture";
  url.password = syntheticCredential("invalid-url");
  return url.toString();
}
