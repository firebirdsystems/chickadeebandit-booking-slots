// Mirrors the subset of /hub-sdk.js that pure logic in logic.js depends on, so
// tests can import logic without the browser-only SDK. Keep in sync with hub-sdk.
export function isAdult(member) {
  return !!member && member.role === "adult";
}
