import { OrchestrationConfig, OrchestrationNode, FilterNodeConfig, MapNodeConfig, ComputeNodeConfig, SortNodeConfig } from './types';

interface PathSegment {
  key: string;
  index: number | null;
  wildcard: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePath(path: string): PathSegment[] {
  return path
    .split('.')
    .filter(Boolean)
    .map((segment) => {
      const match = segment.match(/^([^[\]]+)(?:\[(\d*)\])?$/);
      if (!match) {
        return { key: segment, index: null, wildcard: false };
      }

      const key = match[1];
      const bracket = match[2];
      if (bracket === undefined) {
        return { key, index: null, wildcard: false };
      }
      if (bracket === '') {
        return { key, index: null, wildcard: true };
      }
      return { key, index: Number.parseInt(bracket, 10), wildcard: false };
    });
}

function cloneContainer(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return [...value];
  if (isRecord(value)) return { ...value };
  return {};
}

function normalizeArrayPath(path: string): string {
  return path.replace(/\[\]/g, '').trim().replace(/\.$/, '');
}

function resolveRefValue(ref: string, data: Record<string, unknown>, context?: Record<string, unknown>): unknown {
  if (ref.startsWith('$param.') && context) {
    const paramKey = ref.slice(7);
    return context[paramKey];
  }

  const dataValue = getByPath(data, ref);
  if (dataValue !== undefined) return dataValue;
  if (context && ref in context) return context[ref];
  return undefined;
}

/**
 * Get a value from a nested object using a dot-separated path.
 * e.g. getByPath({ a: { b: 1 } }, 'a.b') => 1
 */
function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const segments = parsePath(path);
  let values: unknown[] = [obj];
  let hasWildcard = false;

  for (const segment of segments) {
    const nextValues: unknown[] = [];

    for (const value of values) {
      if (!isRecord(value)) continue;
      const next = value[segment.key];

      if (segment.wildcard) {
        hasWildcard = true;
        if (Array.isArray(next)) {
          nextValues.push(...next);
        }
      } else if (segment.index !== null) {
        if (Array.isArray(next)) {
          nextValues.push(next[segment.index]);
        }
      } else {
        nextValues.push(next);
      }
    }

    values = nextValues;
    if (values.length === 0) break;
  }

  if (hasWildcard) return values;
  return values[0];
}

/**
 * Set a value on a nested object using a dot-separated path.
 */
function setByPath(obj: unknown, path: string, value: unknown): unknown {
  if (!path) return value;
  const segments = parsePath(path);

  if (segments.some(segment => segment.wildcard)) {
    return obj;
  }

  const result = cloneContainer(obj);
  let current = result as Record<string, unknown>;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    if (segment.index !== null) {
      const existingValue = current[segment.key];
      const currentArray = Array.isArray(existingValue) ? [...existingValue] : [];
      if (isLast) {
        currentArray[segment.index] = value;
        current[segment.key] = currentArray;
      } else {
        currentArray[segment.index] = cloneContainer(currentArray[segment.index]);
        current[segment.key] = currentArray;
        current = currentArray[segment.index] as Record<string, unknown>;
      }
      continue;
    }

    if (isLast) {
      current[segment.key] = value;
    } else {
      current[segment.key] = cloneContainer(current[segment.key]);
      current = current[segment.key] as Record<string, unknown>;
    }
  }

  return result;
}

interface SelectionNode {
  terminal: boolean;
  children: Map<string, SelectionNode>;
}

function createSelectionNode(): SelectionNode {
  return {
    terminal: false,
    children: new Map<string, SelectionNode>(),
  };
}

function deepClone(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => deepClone(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = deepClone(child);
    }
    return result;
  }
  return value;
}

function getOrCreateSelectionChild(node: SelectionNode, key: string): SelectionNode {
  const existing = node.children.get(key);
  if (existing) return existing;
  const created = createSelectionNode();
  node.children.set(key, created);
  return created;
}

function buildSelectionTree(paths: string[]): SelectionNode {
  const root = createSelectionNode();

  for (const path of paths) {
    if (!path) continue;
    const segments = parsePath(path);
    if (segments.length === 0) continue;

    let current = root;
    for (const segment of segments) {
      if (current.terminal) {
        current.terminal = false;
      }
      current = getOrCreateSelectionChild(current, segment.key);
      if (segment.wildcard) {
        if (current.terminal) {
          current.terminal = false;
        }
        current = getOrCreateSelectionChild(current, '__ALL__');
      } else if (segment.index !== null) {
        if (current.terminal) {
          current.terminal = false;
        }
        current = getOrCreateSelectionChild(current, `[${segment.index}]`);
      }
    }
    current.terminal = current.children.size === 0;
  }

  return root;
}

function includeBySelection(value: unknown, node: SelectionNode): unknown {
  if (value === undefined) return undefined;
  if (node.terminal) return deepClone(value);

  if (Array.isArray(value)) {
    const wildcardChild = node.children.get('__ALL__');
    if (wildcardChild) {
      const included = value
        .map(item => includeBySelection(item, wildcardChild))
        .filter(item => item !== undefined);
      return included;
    }

    const indexedChildren = Array.from(node.children.entries()).filter(([key]) => key.startsWith('['));
    if (indexedChildren.length > 0) {
      const result: unknown[] = [];
      for (const [indexKey, childNode] of indexedChildren) {
        const index = Number.parseInt(indexKey.slice(1, -1), 10);
        if (!Number.isInteger(index)) continue;
        const included = includeBySelection(value[index], childNode);
        if (included !== undefined) {
          result[index] = included;
        }
      }
      return result.some(item => item !== undefined) ? result : undefined;
    }

    if (node.children.size > 0) {
      const included = value
        .map(item => includeBySelection(item, node))
        .filter(item => item !== undefined);
      return included;
    }

    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const [key, childNode] of node.children) {
    if (key === '__ALL__' || key.startsWith('[')) continue;
    const included = includeBySelection(value[key], childNode);
    if (included !== undefined) {
      result[key] = included;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function removeBySegments(current: unknown, segments: PathSegment[], index: number): unknown {
  if (current === null || current === undefined) return current;
  if (index >= segments.length) return current;
  const segment = segments[index];
  const isLast = index === segments.length - 1;

  if (Array.isArray(current)) {
    if (segment.wildcard) {
      if (isLast) return [];
      return current.map(item => removeBySegments(item, segments, index + 1));
    }

    if (segment.index !== null) {
      const next = [...current];
      if (segment.index < 0 || segment.index >= next.length) return next;
      if (isLast) {
        next.splice(segment.index, 1);
      } else {
        next[segment.index] = removeBySegments(next[segment.index], segments, index + 1);
      }
      return next;
    }

    return current.map(item => removeBySegments(item, segments, index));
  }

  if (!isRecord(current)) return current;

  const result: Record<string, unknown> = { ...current };
  if (!(segment.key in result)) return result;

  if (segment.wildcard) {
    const currentValue = result[segment.key];
    if (!Array.isArray(currentValue)) return result;
    if (isLast) {
      delete result[segment.key];
      return result;
    }
    result[segment.key] = currentValue.map((item: unknown) => removeBySegments(item, segments, index + 1));
    return result;
  }

  if (segment.index !== null) {
    if (!Array.isArray(result[segment.key])) return result;
    const currentValue = result[segment.key];
    const next = Array.isArray(currentValue) ? [...currentValue] : [];
    if (segment.index < 0 || segment.index >= next.length) {
      result[segment.key] = next;
      return result;
    }
    if (isLast) {
      next.splice(segment.index, 1);
    } else {
      next[segment.index] = removeBySegments(next[segment.index], segments, index + 1);
    }
    result[segment.key] = next;
    return result;
  }

  if (isLast) {
    delete result[segment.key];
    return result;
  }

  result[segment.key] = removeBySegments(result[segment.key], segments, index + 1);
  return result;
}

function removeByPath(data: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (segments.length === 0) return data;
  return removeBySegments(data, segments, 0);
}

function applyArrayItemMapping(data: unknown, fromPath: string, toPath: string): unknown {
  const marker = '[].';
  const markerIndex = fromPath.indexOf(marker);
  if (markerIndex === -1) return data;

  const arrayPath = fromPath.slice(0, markerIndex);
  const itemSourcePath = fromPath.slice(markerIndex + marker.length);
  if (!itemSourcePath) return data;

  const sourceArray = arrayPath ? getByPath(data, arrayPath) : data;
  if (!Array.isArray(sourceArray)) return data;

  const itemTargetPath = toPath.includes('.') || toPath.includes('[')
    ? toPath
    : (() => {
      const sourceSegments = itemSourcePath.split('.');
      if (sourceSegments.length <= 1) return toPath;
      sourceSegments[sourceSegments.length - 1] = toPath;
      return sourceSegments.join('.');
    })();

  const mappedArray = sourceArray.map((item) => {
    if (!isRecord(item)) return item;
    const sourceValue = getByPath(item, itemSourcePath);
    if (sourceValue === undefined) return item;

    let updatedItem = setByPath(item, itemTargetPath, sourceValue);
    if (itemTargetPath !== itemSourcePath) {
      updatedItem = removeByPath(updatedItem, itemSourcePath);
    }
    return updatedItem;
  });

  if (arrayPath) {
    return setByPath(data, arrayPath, mappedArray);
  }
  return mappedArray;
}

/**
 * Apply a filter node: include or exclude specified fields.
 */
function applyFilter(data: unknown, config: FilterNodeConfig): unknown {
  if (!isRecord(data) && !Array.isArray(data)) return data;

  if (!config.fields || config.fields.length === 0) {
    return config.mode === 'include' ? (Array.isArray(data) ? [] : {}) : data;
  }

  if (config.mode === 'include') {
    const selectionTree = buildSelectionTree(config.fields);
    const included = includeBySelection(data, selectionTree);
    if (included === undefined) return Array.isArray(data) ? [] : {};
    return included;
  }

  let result = deepClone(data);
  for (const field of config.fields) {
    result = removeByPath(result, field);
  }
  return result;
}

/**
 * Apply a map node: rename fields.
 */
function applyMap(data: unknown, config: MapNodeConfig): unknown {
  if (!isRecord(data) && !Array.isArray(data)) return data;

  if (Array.isArray(data)) {
    return data.map(item => applyMap(item, config));
  }

  let result: Record<string, unknown> = { ...data };
  for (const mapping of config.mappings) {
    if (mapping.from.includes('[].')) {
      result = applyArrayItemMapping(result, mapping.from, mapping.to) as Record<string, unknown>;
      continue;
    }

    const val = getByPath(result, mapping.from);
    if (val !== undefined) {
      const nextResult = setByPath(result, mapping.to, val);
      result = nextResult as Record<string, unknown>;
      if (mapping.from !== mapping.to && !mapping.from.includes('.') && !mapping.from.includes('[')) {
        delete result[mapping.from];
      }
    }
  }
  return result;
}

/**
 * Apply a compute node: add new computed fields.
 * Supports {{field}} syntax in expressions for referencing data fields.
 * Supports {{$param.key}} for referencing custom params.
 */
function applyCompute(data: unknown, config: ComputeNodeConfig, context?: Record<string, unknown>): unknown {
  if (!isRecord(data) && !Array.isArray(data)) return data;

  if (Array.isArray(data)) {
    return data.map(item => applyCompute(item, config, context));
  }

  let result: Record<string, unknown> = { ...data };
  for (const comp of config.computations) {
    if (!comp.field) continue;
    
    let computedValue: unknown = undefined;
    if (comp.sourceField) {
      // Copy from existing field or param
      computedValue = resolveRefValue(comp.sourceField, result, context);
    } else if (comp.expression) {
      try {
        computedValue = safeEvaluate(comp.expression, result, context);
      } catch {
        computedValue = comp.expression;
      }
    }

    result = setByPath(result, comp.field, computedValue) as Record<string, unknown>;
  }
  return result;
}

/**
 * Safely evaluate an expression with {{field}} reference syntax.
 * Supports: {{fieldName}}, {{$param.key}}, basic arithmetic (+, -, *, /)
 * Example: "{{price}} * 0.1" or "{{$param.taxRate}} * {{total}}"
 */
function safeEvaluate(expression: string, data: Record<string, unknown>, context?: Record<string, unknown>): unknown {
  // Replace {{...}} references with actual values
  const templatePattern = /\{\{([^}]+)\}\}/g;
  const hasTemplates = templatePattern.test(expression);
  templatePattern.lastIndex = 0;
  
  if (hasTemplates) {
    let processedExpr = expression;
    const replacements: Array<{ placeholder: string; value: unknown }> = [];
    
    let match;
    while ((match = templatePattern.exec(expression)) !== null) {
      const ref = match[1].trim();
      let value: unknown = undefined;
      
      value = resolveRefValue(ref, data, context);
      
      replacements.push({ placeholder: match[0], value });
    }

    // If expression is just a single {{ref}}, return the value directly
    if (replacements.length === 1 && expression.trim() === replacements[0].placeholder) {
      return replacements[0].value ?? '';
    }

    // Replace all references with their numeric values
    for (const rep of replacements) {
      if (typeof rep.value === 'number') {
        processedExpr = processedExpr.replace(rep.placeholder, String(rep.value));
      } else if (typeof rep.value === 'string') {
        processedExpr = processedExpr.replace(rep.placeholder, JSON.stringify(rep.value));
      } else if (rep.value === undefined) {
        processedExpr = processedExpr.replace(rep.placeholder, 'undefined');
      } else {
        processedExpr = processedExpr.replace(rep.placeholder, JSON.stringify(rep.value));
      }
    }

    // Evaluate arithmetic expressions
    if (/^[\d\s+\-*/().,"]+$/.test(processedExpr)) {
      try {
        return Function(`"use strict"; return (${processedExpr})`)();
      } catch {
        return processedExpr;
      }
    }
    return processedExpr;
  }

  // Legacy support: bare field references without {{ }}
  const fieldPattern = /\b([a-zA-Z_][a-zA-Z0-9_.]*)\b/g;
  let processedExpr = expression;
  const matches = expression.match(fieldPattern);
  
  if (matches) {
    if (matches.length === 1 && expression.trim() === matches[0]) {
      const val = resolveRefValue(matches[0], data, context);
      if (val !== undefined) return val;
      return expression;
    }
    
    for (const m of matches) {
      const val = resolveRefValue(m, data, context);
      if (val !== undefined && typeof val === 'number') {
        processedExpr = processedExpr.replace(new RegExp(`\\b${m.replace('.', '\\.')}\\b`), String(val));
      }
    }
  }

  if (/^[\d\s+\-*/().]+$/.test(processedExpr)) {
    try {
      return Function(`"use strict"; return (${processedExpr})`)();
    } catch {
      return processedExpr;
    }
  }
  
  return expression;
}

/**
 * Apply a sort node: sort an array field and optionally limit results.
 */
function applySort(data: unknown, config: SortNodeConfig): unknown {
  if (!config.sortField) return data;

  const normalizedArrayPath = normalizeArrayPath(config.arrayPath || '');
  const normalizedSortField = normalizeArrayPath(config.sortField || '');

  let itemSortField = normalizedSortField;
  if (normalizedArrayPath && normalizedSortField.startsWith(`${normalizedArrayPath}.`)) {
    itemSortField = normalizedSortField.slice(normalizedArrayPath.length + 1);
  } else if (normalizedSortField.startsWith('[].')) {
    itemSortField = normalizedSortField.slice(3);
  }
  let effectiveArrayPath = normalizedArrayPath;

  let targetArray: unknown;
  if (effectiveArrayPath) {
    targetArray = getByPath(data, effectiveArrayPath);
  } else {
    targetArray = data;
  }
  
  if (!Array.isArray(targetArray)) {
    if (!effectiveArrayPath && isRecord(data)) {
      const topLevelField = normalizedSortField.split('.')[0];
      if (topLevelField && Array.isArray(data[topLevelField])) {
        targetArray = data[topLevelField];
        effectiveArrayPath = topLevelField;
        itemSortField = normalizedSortField.slice(topLevelField.length + 1);
      }
    }

    // Try to find array in root-level values if no explicit path
    if (!Array.isArray(targetArray) && !effectiveArrayPath && isRecord(data)) {
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) {
          targetArray = data[key];
          const implicitSortField = normalizedSortField.startsWith(`${key}.`)
            ? normalizedSortField.slice(key.length + 1)
            : normalizedSortField;
          const sorted = sortArray(targetArray as unknown[], { ...config, arrayPath: key, sortField: implicitSortField });
          return { ...data, [key]: sorted };
        }
      }
    }
    if (!Array.isArray(targetArray)) {
      return data;
    }
  }

  const sortConfig: SortNodeConfig = {
    ...config,
    arrayPath: effectiveArrayPath,
    sortField: itemSortField,
  };
  const sorted = sortArray(targetArray as unknown[], sortConfig);

  if (effectiveArrayPath) {
    return setByPath(data, effectiveArrayPath, sorted);
  }
  return sorted;
}

function sortArray(arr: unknown[], config: SortNodeConfig): unknown[] {
  const sorted = [...arr].sort((a, b) => {
    const aVal = getByPath(a, config.sortField);
    const bVal = getByPath(b, config.sortField);
    
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return config.order === 'asc' ? aVal - bVal : bVal - aVal;
    }
    
    const aStr = String(aVal ?? '');
    const bStr = String(bVal ?? '');
    return config.order === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
  });

  return config.limit && config.limit > 0 ? sorted.slice(0, config.limit) : sorted;
}

/**
 * Apply a single orchestration node.
 */
export function applyNode(data: unknown, node: OrchestrationNode, context?: Record<string, unknown>): unknown {
  switch (node.type) {
    case 'filter':
      return applyFilter(data, node.config as FilterNodeConfig);
    case 'map':
      return applyMap(data, node.config as MapNodeConfig);
    case 'compute':
      return applyCompute(data, node.config as ComputeNodeConfig, context);
    case 'sort':
      return applySort(data, node.config as SortNodeConfig);
    default:
      return data;
  }
}

/**
 * Apply the full orchestration pipeline: execute nodes in order.
 */
export function applyOrchestration(data: unknown, config: OrchestrationConfig, context?: Record<string, unknown>): unknown {
  if (!config || !config.nodes || config.nodes.length === 0) return data;

  const sortedNodes = [...config.nodes].sort((a, b) => a.order - b.order);
  
  let result = data;
  for (const node of sortedNodes) {
    result = applyNode(result, node, context);
  }
  return result;
}

/**
 * Apply orchestration up to a specific node (for debugging).
 */
export function applyOrchestrationUpTo(
  data: unknown,
  config: OrchestrationConfig,
  nodeId: string,
  context?: Record<string, unknown>
): { result: unknown; nodeResults: Record<string, unknown> } {
  if (!config || !config.nodes || config.nodes.length === 0) {
    return { result: data, nodeResults: {} };
  }

  const sortedNodes = [...config.nodes].sort((a, b) => a.order - b.order);
  const nodeResults: Record<string, unknown> = {};
  
  let result = data;
  for (const node of sortedNodes) {
    result = applyNode(result, node, context);
    nodeResults[node.id] = JSON.parse(JSON.stringify(result));
    if (node.id === nodeId) break;
  }
  
  return { result, nodeResults };
}
