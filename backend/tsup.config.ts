import { defineConfig } from 'tsup';

/**
 * The server is bundled rather than emitted file-by-file. Bundling resolves the
 * `@shared/*` path alias at build time, so the deployed artefact is a single ESM file
 * with no runtime path-mapping shim — one fewer thing to go wrong on Render.
 *
 * Dependencies stay external (tsup's default), so node_modules is still installed
 * normally in production.
 */
export default defineConfig({
  entry: ['src/server.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  // The Mongo driver requires these conditionally for optional features (Kerberos
  // auth, client-side field-level encryption, zstd/snappy compression); none are
  // installed, and bundling must not try to resolve them.
  external: ['kerberos', 'mongodb-client-encryption', '@mongodb-js/zstd', 'snappy', '@aws-sdk/credential-providers'],
});
