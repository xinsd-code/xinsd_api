export type JsonBodyFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface JsonBodyField {
  path: string;
  type: JsonBodyFieldType;
  value: string;
}

type JsonPathSegment = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function detectJsonBodyFieldType(value: unknown): JsonBodyFieldType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isRecord(value)) return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return 'string';
}

export function parseJsonBody(value: string): { data: unknown | null; error: string | null } {
  if (!value.trim()) {
    return { data: {}, error: null };
  }

  try {
    return { data: JSON.parse(value), error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : 'JSON 解析失败',
    };
  }
}

function serializeJsonBodyValue(value: unknown, type: JsonBodyFieldType): string {
  if (type === 'object' || type === 'array') {
    return JSON.stringify(value, null, 2);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function flattenJsonBody(value: unknown, basePath = ''): JsonBodyField[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return basePath
        ? [{ path: basePath, type: 'array', value: '[]' }]
        : [];
    }

    return value.flatMap((item, index) => flattenJsonBody(item, `${basePath}[${index}]`));
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return basePath
        ? [{ path: basePath, type: 'object', value: '{}' }]
        : [];
    }

    return entries.flatMap(([key, item]) => flattenJsonBody(item, basePath ? `${basePath}.${key}` : key));
  }

  if (!basePath) {
    return [];
  }

  const fieldType = detectJsonBodyFieldType(value);
  return [
    {
      path: basePath,
      type: fieldType,
      value: serializeJsonBodyValue(value, fieldType),
    },
  ];
}

function normalizeJsonPath(path: string): string {
  return path.trim().replace(/^\$\.?/, '');
}

export function parseJsonPath(path: string): JsonPathSegment[] {
  const normalized = normalizeJsonPath(path);
  if (!normalized) return [];

  const segments: JsonPathSegment[] = [];
  const matcher = /([^[.\]]+)|\[(\d+)\]/g;
  let result: RegExpExecArray | null;

  while ((result = matcher.exec(normalized)) !== null) {
    if (result[1] !== undefined) {
      segments.push(result[1]);
      continue;
    }
    if (result[2] !== undefined) {
      segments.push(Number(result[2]));
    }
  }

  return segments;
}

function setDeepValue(target: Record<string, unknown> | unknown[], path: JsonPathSegment[], value: unknown): void {
  let current: Record<string, unknown> | unknown[] = target;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];
    const nextContainer = typeof nextSegment === 'number' ? [] : {};

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        return;
      }
      if (current[segment] === undefined || current[segment] === null) {
        current[segment] = nextContainer;
      }
      current = current[segment] as Record<string, unknown> | unknown[];
      continue;
    }

    if (!isRecord(current)) {
      return;
    }
    if (current[segment] === undefined || current[segment] === null) {
      current[segment] = nextContainer;
    }
    current = current[segment] as Record<string, unknown> | unknown[];
  }

  const lastSegment = path[path.length - 1];
  if (lastSegment === undefined) return;

  if (typeof lastSegment === 'number') {
    if (!Array.isArray(current)) return;
    current[lastSegment] = value;
    return;
  }

  if (!isRecord(current)) return;
  current[lastSegment] = value;
}

function coerceJsonBodyFieldValue(field: JsonBodyField): unknown {
  const trimmed = field.value.trim();

  switch (field.type) {
    case 'string':
      return field.value;
    case 'integer':
      return trimmed === '' ? null : parseInt(trimmed, 10);
    case 'number':
      return trimmed === '' ? null : Number(trimmed);
    case 'boolean':
      return trimmed === '' ? false : trimmed === 'true';
    case 'object':
      return trimmed ? JSON.parse(trimmed) : {};
    case 'array':
      return trimmed ? JSON.parse(trimmed) : [];
    case 'null':
      return null;
    default:
      return field.value;
  }
}

export function buildJsonBodyFromFields(fields: JsonBodyField[]): unknown {
  const validFields = fields.filter((field) => parseJsonPath(field.path).length > 0);
  if (validFields.length === 0) {
    return {};
  }

  const firstPath = parseJsonPath(validFields[0].path);
  const root: Record<string, unknown> | unknown[] = typeof firstPath[0] === 'number' ? [] : {};

  validFields.forEach((field) => {
    const path = parseJsonPath(field.path);
    if (path.length === 0) return;
    setDeepValue(root, path, coerceJsonBodyFieldValue(field));
  });

  return root;
}

function isIgnoredConfiguredValue(value: unknown): boolean {
  if (value === '' || value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => isIgnoredConfiguredValue(item));
  }
  if (isRecord(value)) {
    const entries = Object.values(value);
    return entries.length === 0 || entries.every((item) => isIgnoredConfiguredValue(item));
  }
  return false;
}

function deepMatchConfiguredJson(expected: unknown, actual: unknown): boolean {
  if (isIgnoredConfiguredValue(expected)) {
    return true;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((item, index) => deepMatchConfiguredJson(item, actual[index]));
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      deepMatchConfiguredJson(value, actual[key])
    );
  }

  return Object.is(expected, actual) || String(expected) === String(actual ?? '');
}

export function matchConfiguredJsonBody(configuredBody: string | undefined, actualBody: unknown): boolean {
  if (!configuredBody || !configuredBody.trim()) {
    return true;
  }

  const parsed = parseJsonBody(configuredBody);
  if (parsed.error || parsed.data === null) {
    return true;
  }

  return deepMatchConfiguredJson(parsed.data, actualBody);
}
