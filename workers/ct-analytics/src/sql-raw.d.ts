// Vite/Vitest `?raw` imports return the file's text. Used by tests to load the
// D1 migrations without node:fs (the worker tsconfig has no @types/node).
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
