const env = process.env as Record<string, string | undefined>;
env.NODE_ENV ??= 'test';
env.SECRET_KEY ??= '0'.repeat(64); // 64-char hex required by the validator
env.BASE_URL ??= 'http://localhost:3000'; // Vite-injected '/' would fail it
env.LOG_LEVEL ??= 'error'; // keep test output clean; override to debug locally

// Import the core barrel once, before any test file runs, so the
// pre-existing logger <-> config <-> tasks import cycle resolves the same
// way it does in production (packages/server/src/app.ts pulls this in
// first). Without this, whichever test file happens to import a db-backed
// module first can hit the module TDZ instead. Individual test files no
// longer need their own `import '../index.js'` workaround.
await import('../src/index.js');
