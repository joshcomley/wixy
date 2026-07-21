// Ambient module for vite's `?raw` imports — lets tests read shared fixture
// files (builder/tests/fixtures/*) as plain strings without @types/node
// (vitest resolves `?raw` at runtime; tsc only needs the type shape).
declare module "*?raw" {
  const content: string;
  export default content;
}
