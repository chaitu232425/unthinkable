import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { openApiDocument } from '../../src/docs/openapi.js';

/**
 * Documentation drift guard.
 *
 * Walks the live Express router stack and compares it to the OpenAPI document. A route
 * added without documentation — or documented but never mounted — fails the build.
 * Hand-written specs rot; this is what stops that happening quietly.
 */

interface RouteInfo {
  method: string;
  path: string;
}

function collectRoutes(app: ReturnType<typeof createApp>): RouteInfo[] {
  const routes: RouteInfo[] = [];

  const walk = (stack: unknown[], prefix: string): void => {
    for (const raw of stack) {
      const layer = raw as {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: RegExp;
      };

      if (layer.route) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled || method === '_all') continue;
          routes.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Recover the mount path from the router's regexp.
        const source = layer.regexp?.source ?? '';
        const mount = source
          .replace('^\\/', '/')
          .replace('\\/?(?=\\/|$)', '')
          .replace(/\\\//g, '/')
          .replace(/\$$/, '')
          .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, '');
        walk(layer.handle.stack, prefix + (mount === '/' ? '' : mount));
      }
    }
  };

  walk((app as unknown as { _router: { stack: unknown[] } })._router.stack, '');
  return routes;
}

/** `/api/venues/:id` → `/api/venues/{id}` */
const toOpenApiPath = (path: string) => {
  const withBraces = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  // A router mounted at `/api/venues` with a route of `/` yields `/api/venues/`;
  // OpenAPI writes that as `/api/venues`.
  return withBraces.length > 1 ? withBraces.replace(/\/+$/, '') : withBraces;
};

/** Routes that exist but are intentionally not part of the documented contract. */
const UNDOCUMENTED_BY_DESIGN = new Set(['GET /api/openapi.json']);

describe('OpenAPI document', () => {
  const app = createApp();
  const routes = collectRoutes(app).filter(
    (r) => !r.path.startsWith('/api/docs') && !UNDOCUMENTED_BY_DESIGN.has(`${r.method} ${r.path}`),
  );

  it('finds the mounted routes', () => {
    expect(routes.length).toBeGreaterThan(25);
  });

  it('documents every mounted route', () => {
    const documented = new Set<string>();
    for (const [path, item] of Object.entries(openApiDocument.paths)) {
      for (const method of Object.keys(item)) {
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const missing = routes
      .map((r) => `${r.method} ${toOpenApiPath(r.path)}`)
      .filter((key) => !documented.has(key))
      .sort();

    expect(missing, `Undocumented routes:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('does not document routes that are not mounted', () => {
    const mounted = new Set(routes.map((r) => `${r.method} ${toOpenApiPath(r.path)}`));

    const phantom: string[] = [];
    for (const [path, item] of Object.entries(openApiDocument.paths)) {
      for (const method of Object.keys(item)) {
        const key = `${method.toUpperCase()} ${path}`;
        if (!mounted.has(key)) phantom.push(key);
      }
    }

    expect(phantom.sort(), `Documented but not mounted:\n  ${phantom.join('\n  ')}`).toEqual([]);
  });

  it('declares the error envelope every endpoint uses', () => {
    expect(openApiDocument.components.schemas.Error).toBeDefined();
    expect(openApiDocument.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});
