import { match, MatchFunction } from 'path-to-regexp';
import { MockAPI, KeyValuePair } from './types';

/**
 * Test if a request path matches a mock API path pattern.
 * Supports RESTful path parameters like /users/:id, /users/:userId/posts/:postId
 */
export function matchPath(
  mockPath: string,
  requestPath: string
): { matched: boolean; params: Record<string, string> } {
  try {
    // Normalize paths
    const normalizedMock = normalizePath(mockPath);
    const normalizedRequest = normalizePath(requestPath);

    const matchFn: MatchFunction = match(normalizedMock, { decode: decodeURIComponent });
    const result = matchFn(normalizedRequest);

    if (result) {
      return {
        matched: true,
        params: result.params as Record<string, string>,
      };
    }
    return { matched: false, params: {} };
  } catch {
    return { matched: false, params: {} };
  }
}

/**
 * Normalize a path by ensuring it starts with / and removing trailing /
 */
function normalizePath(p: string): string {
  let normalized = p.startsWith('/') ? p : '/' + p;
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Check if request headers match mock configured headers.
 * All configured headers (with non-empty key AND value) must be present in the request.
 * Headers with empty key or empty value are skipped.
 */
export function matchHeaders(
  configuredHeaders: KeyValuePair[],
  requestHeaders: Record<string, string>
): boolean {
  if (!configuredHeaders || configuredHeaders.length === 0) return true;

  const normalizedRequestHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    normalizedRequestHeaders[key.toLowerCase()] = value;
  }

  return configuredHeaders.every(({ key, value }) => {
    if (!key || !value) return true; // skip entries without both key and value
    const requestValue = normalizedRequestHeaders[key.toLowerCase()];
    return requestValue === value;
  });
}

/**
 * Check if request query/body params match mock configured params.
 * All configured params (with non-empty key AND value) must be present in the request.
 * Params with empty key or empty value are skipped.
 */
export function matchParams(
  configuredParams: KeyValuePair[],
  requestParams: Record<string, string>
): boolean {
  if (!configuredParams || configuredParams.length === 0) return true;

  return configuredParams.every(({ key, value }) => {
    if (!key || !value) return true; // skip entries without both key and value
    const requestValue = requestParams[key];
    return requestValue === value;
  });
}

/**
 * Find the best matching mock API for a given request.
 */
export function findMatchingMock(
  mocks: MockAPI[],
  method: string,
  requestPath: string,
  requestHeaders: Record<string, string>,
  requestParams: Record<string, string>
): { mock: MockAPI; pathParams: Record<string, string> } | null {
  for (const mock of mocks) {
    // Check method
    if (mock.method !== method.toUpperCase() && mock.method !== '*') {
      continue;
    }

    // Check path
    const pathResult = matchPath(mock.path, requestPath);
    if (!pathResult.matched) continue;

    // Check headers
    if (!matchHeaders(mock.requestHeaders, requestHeaders)) continue;

    // Check params
    if (!matchParams(mock.requestParams, requestParams)) continue;

    return { mock, pathParams: pathResult.params };
  }

  return null;
}
