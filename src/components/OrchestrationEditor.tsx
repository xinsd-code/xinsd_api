'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { flattenAIModelSelections, getAIModelSelectionKey, getDefaultAIModelSelection } from '@/lib/ai-models';
import {
  AIModelProfile,
  AIModelSelection,
  ApiForwardTargetType,
  OrchestrationConfig,
  OrchestrationNode,
  OrchestrationNodeType,
  FilterNodeConfig,
  MapNodeConfig,
  ComputeNodeConfig,
  SortNodeConfig,
  CustomParamDef,
  ParamBinding,
} from '@/lib/types';
import { applyNode } from '@/lib/orchestration-engine';
import { Icons } from './Icons';
import styles from './orchestration.module.css';

const NODE_TYPE_META: Record<OrchestrationNodeType, { icon: React.ReactNode; label: string; color: string }> = {
  filter: { icon: <Icons.Search size={14} />, label: '数据筛选', color: 'filter' },
  map: { icon: <Icons.Refresh size={14} />, label: '字段映射', color: 'map' },
  compute: { icon: <Icons.Zap size={14} />, label: '字段新增', color: 'compute' },
  sort: { icon: <Icons.Activity size={14} />, label: '排序限制', color: 'sort' },
};

interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  diffLines?: string[];
}

interface ValidationIssue {
  severity: 'warning' | 'error';
  message: string;
  nodeId?: string;
}

type AiChatMode = 'general' | 'fix-validation';

const AI_CHAT_SUGGESTIONS = [
  '保留核心字段并整理输出结构',
  '把列表按时间倒序，只保留最近 20 条',
  '新增计算字段，组合多个字段生成展示文案',
];

function createDefaultConfig(type: OrchestrationNodeType): FilterNodeConfig | MapNodeConfig | ComputeNodeConfig | SortNodeConfig {
  switch (type) {
    case 'filter': return { mode: 'include', fields: [] };
    case 'map': return { mappings: [] };
    case 'compute': return { computations: [] };
    case 'sort': return { arrayPath: '', sortField: '', order: 'asc', limit: undefined };
  }
}

function generateNodeId(): string {
  return 'n_' + Math.random().toString(36).substring(2, 9);
}

function generateChatMessageId(): string {
  return 'm_' + Math.random().toString(36).substring(2, 9);
}

function getModelOptionLabel(model: AIModelSelection): string {
  return `${model.profileName} / ${model.modelId}`;
}

function parseSseBlocks(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const events: Array<{ event: string; data: string }> = [];
  let remaining = buffer;

  let boundaryIndex = remaining.indexOf('\n\n');
  while (boundaryIndex !== -1) {
    const block = remaining.slice(0, boundaryIndex);
    remaining = remaining.slice(boundaryIndex + 2);

    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');

      if (data) {
        events.push({ event, data });
      }
    }

    boundaryIndex = remaining.indexOf('\n\n');
  }

  return { events, rest: remaining };
}

function summarizeWorkflowDiff(previous: OrchestrationConfig, next: OrchestrationConfig): string[] {
  const previousNodes = previous.nodes || [];
  const nextNodes = next.nodes || [];
  const previousMap = new Map(previousNodes.map((node) => [node.id, node]));
  const nextMap = new Map(nextNodes.map((node) => [node.id, node]));
  const lines: string[] = [];

  const addedNodes = nextNodes.filter((node) => !previousMap.has(node.id));
  const removedNodes = previousNodes.filter((node) => !nextMap.has(node.id));
  const changedNodes = nextNodes.filter((node) => {
    const previousNode = previousMap.get(node.id);
    if (!previousNode) return false;
    return previousNode.label !== node.label
      || previousNode.order !== node.order
      || JSON.stringify(previousNode.config) !== JSON.stringify(node.config);
  });

  if (addedNodes.length > 0) {
    lines.push(`新增 ${addedNodes.length} 个节点：${addedNodes.slice(0, 3).map((node) => node.label || NODE_TYPE_META[node.type].label).join('、')}${addedNodes.length > 3 ? '…' : ''}`);
  }
  if (removedNodes.length > 0) {
    lines.push(`删除 ${removedNodes.length} 个节点：${removedNodes.slice(0, 3).map((node) => node.label || NODE_TYPE_META[node.type].label).join('、')}${removedNodes.length > 3 ? '…' : ''}`);
  }
  if (changedNodes.length > 0) {
    lines.push(`修改 ${changedNodes.length} 个节点：${changedNodes.slice(0, 3).map((node) => node.label || NODE_TYPE_META[node.type].label).join('、')}${changedNodes.length > 3 ? '…' : ''}`);
  }
  if (lines.length === 0) {
    lines.push('未检测到结构差异，可能仅做了细微标准化或说明性修复。');
  }

  return lines;
}

function normalizeSortFieldValue(sortField: string, arrayPath: string): string {
  const normalizedSortField = normalizePath(sortField || '');
  const normalizedArrayPath = normalizePath(arrayPath || '');

  if (!normalizedSortField) return '';
  if (normalizedArrayPath && normalizedSortField.startsWith(`${normalizedArrayPath}.`)) {
    return normalizedSortField.slice(normalizedArrayPath.length + 1);
  }
  if (normalizedSortField.startsWith('[].')) {
    return normalizedSortField.slice(3);
  }
  return normalizedSortField;
}

function rebasePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (!path || !fromPrefix || !toPrefix || fromPrefix === toPrefix) return path;
  if (path === fromPrefix) return toPrefix;
  if (path.startsWith(`${fromPrefix}[].`)) {
    return `${toPrefix}[].${path.slice(fromPrefix.length + 3)}`;
  }
  if (path.startsWith(`${fromPrefix}.`)) {
    return `${toPrefix}.${path.slice(fromPrefix.length + 1)}`;
  }
  return path;
}

function extractArrayPrefixes(paths: string[]): string[] {
  return Array.from(
    new Set(
      paths
        .filter((path) => path.includes('[].'))
        .map((path) => path.slice(0, path.indexOf('[].')))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function normalizeSortNodeConfig(config: SortNodeConfig): { config: SortNodeConfig; changed: boolean } {
  const rawArrayPath = normalizePath(config.arrayPath || '');
  const rawSortField = normalizePath(config.sortField || '');

  if (!rawSortField) {
    const nextArrayPath = rawArrayPath;
    const changed = nextArrayPath !== (config.arrayPath || '');
    return {
      config: {
        ...config,
        arrayPath: nextArrayPath,
      },
      changed,
    };
  }

  let nextArrayPath = rawArrayPath;
  let nextSortField = rawSortField;

  if (!nextArrayPath && rawSortField.includes('[].')) {
    const markerIndex = rawSortField.indexOf('[].');
    nextArrayPath = rawSortField.slice(0, markerIndex);
    nextSortField = rawSortField.slice(markerIndex + 3);
  } else {
    nextSortField = normalizeSortFieldValue(rawSortField, nextArrayPath);
  }

  const changed = nextArrayPath !== (config.arrayPath || '') || nextSortField !== (config.sortField || '');

  return {
    config: {
      ...config,
      arrayPath: nextArrayPath,
      sortField: nextSortField,
    },
    changed,
  };
}

function normalizeWorkflowConfig(config: OrchestrationConfig): { config: OrchestrationConfig; changes: string[] } {
  const changes: string[] = [];

  const nodes = config.nodes.map((node) => {
    if (node.type !== 'sort') return node;

    const normalized = normalizeSortNodeConfig(node.config as SortNodeConfig);
    if (!normalized.changed) return node;

    changes.push(`已修正排序节点“${node.label || '排序限制'}”的字段写法`);
    return {
      ...node,
      config: normalized.config,
    };
  });

  return {
    config: { ...config, nodes },
    changes,
  };
}

function projectFieldPathsByMappings(paths: string[], mappings: MapNodeConfig['mappings']): string[] {
  const projected = [...paths];

  for (const mapping of mappings) {
    if (!mapping.from || !mapping.to) continue;

    for (let i = 0; i < projected.length; i++) {
      projected[i] = rebasePathPrefix(projected[i], mapping.from, mapping.to);
    }
  }

  return Array.from(new Set(projected)).sort((a, b) => a.localeCompare(b));
}

function validateWorkflowConfig(
  config: OrchestrationConfig,
  arrayFieldOptions: ArrayFieldOption[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const arrayPathSet = new Set(arrayFieldOptions.map((option) => normalizePath(option.arrayPath || '')));

  for (const node of config.nodes) {
    const label = node.label || NODE_TYPE_META[node.type].label;

    if (node.type === 'filter') {
      const cfg = node.config as FilterNodeConfig;
      if (!cfg.fields || cfg.fields.length === 0) {
        issues.push({ severity: 'warning', message: `节点“${label}”尚未选择字段`, nodeId: node.id });
      }
      continue;
    }

    if (node.type === 'map') {
      const cfg = node.config as MapNodeConfig;
      if (!cfg.mappings || cfg.mappings.length === 0) {
        issues.push({ severity: 'warning', message: `节点“${label}”尚未配置映射规则`, nodeId: node.id });
        continue;
      }

      const invalidMapping = cfg.mappings.find((mapping) => !mapping.from || !mapping.to);
      if (invalidMapping) {
        issues.push({ severity: 'error', message: `节点“${label}”存在未填完整的映射规则`, nodeId: node.id });
      }
      continue;
    }

    if (node.type === 'compute') {
      const cfg = node.config as ComputeNodeConfig;
      if (!cfg.computations || cfg.computations.length === 0) {
        issues.push({ severity: 'warning', message: `节点“${label}”尚未配置计算规则`, nodeId: node.id });
        continue;
      }

      for (const computation of cfg.computations) {
        if (!computation.field) {
          issues.push({ severity: 'error', message: `节点“${label}”存在缺少目标字段的计算规则`, nodeId: node.id });
          break;
        }
        if (!computation.expression && !computation.sourceField) {
          issues.push({ severity: 'error', message: `节点“${label}”存在缺少数据来源和表达式的计算规则`, nodeId: node.id });
          break;
        }
        if (computation.field.includes('[') && !computation.field.includes('[].')) {
          issues.push({ severity: 'warning', message: `节点“${label}”的目标字段“${computation.field}”建议使用 list[].field 形式`, nodeId: node.id });
          break;
        }
      }
      continue;
    }

    if (node.type === 'sort') {
      const cfg = normalizeSortNodeConfig(node.config as SortNodeConfig).config;
      if (!cfg.sortField) {
        issues.push({ severity: 'error', message: `节点“${label}”尚未选择排序字段`, nodeId: node.id });
        continue;
      }

      const normalizedArrayPath = normalizePath(cfg.arrayPath || '');
      if (normalizedArrayPath && arrayFieldOptions.length > 0 && !arrayPathSet.has(normalizedArrayPath)) {
        issues.push({ severity: 'warning', message: `节点“${label}”的数组路径“${cfg.arrayPath}”未在当前输出中识别到`, nodeId: node.id });
        continue;
      }

      const selectedArray = arrayFieldOptions.find((option) => normalizePath(option.arrayPath || '') === normalizedArrayPath);
      if (selectedArray && cfg.sortField && !selectedArray.itemFields.includes(cfg.sortField)) {
        issues.push({ severity: 'warning', message: `节点“${label}”的排序字段“${cfg.sortField}”不在数组项字段列表中`, nodeId: node.id });
      }
    }
  }

  return issues;
}

function buildPreviewParams(customParams: CustomParamDef[], baseParams: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...baseParams };
  for (const param of customParams) {
    if (merged[param.key] === undefined) {
      merged[param.key] = param.defaultValue || '';
    }
  }
  return merged;
}

interface ArrayFieldOption {
  arrayPath: string;
  itemFields: string[];
}

interface FieldTreeNode {
  key: string;
  path: string;
  children: FieldTreeNode[];
}

function compactFilterFieldsForTree(paths: string[]): string[] {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  return unique.filter((path) => !unique.some((other) => other.startsWith(`${path}[].`)));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeFilterFieldsForConfig(fields: string[], availableFields: string[]): string[] {
  if (availableFields.length === 0) return Array.from(new Set(fields.filter(Boolean)));

  const compactFields = compactFilterFieldsForTree(availableFields);
  const compactSet = new Set(compactFields);
  const normalized = new Set<string>();

  for (const field of fields) {
    if (!field) continue;
    if (compactSet.has(field)) {
      normalized.add(field);
      continue;
    }

    const childPrefix = field.endsWith('[]') ? `${field}.` : `${field}[].`;
    const children = compactFields.filter((path) => path.startsWith(childPrefix));
    for (const child of children) {
      normalized.add(child);
    }
  }

  return Array.from(normalized).sort((a, b) => a.localeCompare(b));
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizePath(path: string): string {
  return path.replace(/\[\]/g, '').trim().replace(/\.$/, '');
}

function buildFieldTree(paths: string[]): FieldTreeNode[] {
  type MutableNode = FieldTreeNode & { childMap: Map<string, MutableNode> };
  const rootMap = new Map<string, MutableNode>();

  for (const path of Array.from(new Set(paths.filter(Boolean)))) {
    const segments = path.split('.').filter(Boolean);
    let currentMap = rootMap;
    const currentPath: string[] = [];

    for (const segment of segments) {
      currentPath.push(segment);
      const fullPath = currentPath.join('.');
      let node = currentMap.get(segment);
      if (!node) {
        node = { key: segment, path: fullPath, children: [], childMap: new Map<string, MutableNode>() };
        currentMap.set(segment, node);
      }
      currentMap = node.childMap;
    }
  }

  const convert = (map: Map<string, MutableNode>): FieldTreeNode[] => {
    return Array.from(map.values())
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => ({
        key: node.key,
        path: node.path,
        children: convert(node.childMap),
      }));
  };

  return convert(rootMap);
}

/** 递归提取JSON对象的所有key路径，支持array中对象属性展开 */
function extractFieldPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (Array.isArray(obj)) {
    const objectItems = obj.filter(item => isObjectLike(item) && !Array.isArray(item));
    if (objectItems.length > 0) {
      const arrPrefix = prefix || '';
      const fieldSet = new Set<string>();
      for (const item of objectItems.slice(0, 10)) {
        for (const field of extractFieldPaths(item, '')) {
          fieldSet.add(arrPrefix ? `${arrPrefix}[].${field}` : field);
        }
      }
      return [...fieldSet];
    }
    return [];
  }
  if (!isObjectLike(obj)) return [];
  const fields: string[] = [];
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    fields.push(path);
    const val = obj[key];
    if (Array.isArray(val)) {
      // Array of objects: add array marker and sub-fields
      if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        const subFields = extractFieldPaths(val[0], '');
        for (const sf of subFields) {
          fields.push(`${path}[].${sf}`);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      fields.push(...extractFieldPaths(val, path));
    }
  }
  return fields;
}

/** 提取数组对象路径 + 可排序字段 */
function extractArrayFieldOptions(obj: unknown): ArrayFieldOption[] {
  const optionsMap = new Map<string, Set<string>>();

  const collectArrayFields = (arr: unknown[], arrayPath: string) => {
    const objectItems = arr.filter(item => isObjectLike(item) && !Array.isArray(item));
    if (objectItems.length === 0) return;

    const current = optionsMap.get(arrayPath) ?? new Set<string>();
    for (const item of objectItems.slice(0, 10)) {
      for (const field of extractFieldPaths(item, '')) {
        current.add(field);
      }
    }
    optionsMap.set(arrayPath, current);
  };

  const visit = (value: unknown, currentPath: string) => {
    if (Array.isArray(value)) {
      collectArrayFields(value, currentPath);
      return;
    }
    if (!isObjectLike(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      visit(child, nextPath);
    }
  };

  visit(obj, '');

  return Array.from(optionsMap.entries())
    .map(([arrayPath, itemFields]) => ({
      arrayPath,
      itemFields: Array.from(itemFields).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.arrayPath.localeCompare(b.arrayPath));
}

// ============================================
// Node Config Editors with Checkbox Selection
// ============================================

function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const checkboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className={styles.fieldCheckbox}
    />
  );
}

function FieldTreePicker({
  tree,
  selectedSet,
  selectablePathSet,
  updateByPaths,
  getNodeLabel,
  onToggle,
  level = 0,
}: {
  tree: FieldTreeNode[];
  selectedSet: Set<string>;
  selectablePathSet: Set<string>;
  updateByPaths: (paths: string[], checked: boolean) => void;
  getNodeLabel: (node: FieldTreeNode) => string;
  onToggle?: (path: string) => void;
  level?: number;
}) {
  const getNodeSelectablePaths = useCallback((node: FieldTreeNode): string[] => {
    const paths: string[] = [];
    if (selectablePathSet.has(node.path)) {
      paths.push(node.path);
    }
    const collectChildren = (n: FieldTreeNode) => {
      for (const child of n.children) {
        if (selectablePathSet.has(child.path)) {
          paths.push(child.path);
        }
        collectChildren(child);
      }
    };
    collectChildren(node);
    return paths;
  }, [selectablePathSet]);

  return (
    <>
      {tree.map((node) => (
        <div key={node.path}>
          {(() => {
            const selectablePaths = getNodeSelectablePaths(node);
            const selectedCount = selectablePaths.filter((path) => selectedSet.has(path)).length;
            const totalCount = selectablePaths.length;
            const checked = totalCount > 0 && selectedCount === totalCount;
            const indeterminate = selectedCount > 0 && selectedCount < totalCount;

            return (
              <label className={styles.fieldCheckboxItem} style={{ paddingLeft: 12 + level * 16 }}>
                <TriStateCheckbox
                  checked={checked}
                  indeterminate={indeterminate}
                  onChange={() => {
                    if (onToggle && selectablePaths.length === 0) {
                      onToggle(node.path);
                      return;
                    }
                    updateByPaths(selectablePaths, checked);
                  }}
                />
                <span className={styles.fieldName}>{getNodeLabel(node)}</span>
              </label>
            );
          })()}
          {node.children.length > 0 && (
            <FieldTreePicker
              tree={node.children}
              selectedSet={selectedSet}
              selectablePathSet={selectablePathSet}
              updateByPaths={updateByPaths}
              getNodeLabel={getNodeLabel}
              onToggle={onToggle}
              level={level + 1}
            />
          )}
        </div>
      ))}
    </>
  );
}

function FilterConfigEditor({
  config, onChange, availableFields,
}: {
  config: FilterNodeConfig;
  onChange: (c: FilterNodeConfig) => void;
  availableFields: string[];
}) {
  const compactFields = useMemo(() => compactFilterFieldsForTree(availableFields), [availableFields]);
  const fieldTree = useMemo(() => buildFieldTree(compactFields), [compactFields]);
  const normalizedFields = useMemo(
    () => normalizeFilterFieldsForConfig(config.fields, availableFields),
    [config.fields, availableFields]
  );
  const selectedSet = useMemo(() => new Set(normalizedFields), [normalizedFields]);
  const selectablePathSet = useMemo(() => new Set(compactFields), [compactFields]);

  useEffect(() => {
    if (!arraysEqual(config.fields, normalizedFields)) {
      onChange({ ...config, fields: normalizedFields });
    }
  }, [config, normalizedFields, onChange]);

  const toggleField = (field: string) => {
    const fields = normalizedFields.includes(field)
      ? normalizedFields.filter(f => f !== field)
      : [...normalizedFields, field];
    onChange({ ...config, fields });
  };

  const updateByPaths = (paths: string[], currentlyChecked: boolean) => {
    const nextSet = new Set(normalizedFields);
    for (const path of paths) {
      if (currentlyChecked) {
        nextSet.delete(path);
      } else {
        nextSet.add(path);
      }
    }
    onChange({ ...config, fields: Array.from(nextSet).sort((a, b) => a.localeCompare(b)) });
  };

  const getNodeLabel = (node: FieldTreeNode) => node.key;

  return (
    <div>
      <div className={styles.configSection}>
        <div className={styles.configSectionTitle}>模式</div>
        <select
          value={config.mode}
          onChange={(e) => onChange({ ...config, mode: e.target.value as 'include' | 'exclude' })}
          className="form-select" style={{ fontSize: 13 }}
        >
          <option value="include">保留字段 (Include)</option>
          <option value="exclude">排除字段 (Exclude)</option>
        </select>
      </div>
      <div className={styles.configSection}>
        <div className={styles.configSectionTitle}>选择字段</div>
        {availableFields.length > 0 ? (
          <div className={styles.fieldCheckboxList}>
            <div className={styles.fieldTreeBrace}>{'{'}</div>
            <FieldTreePicker
              tree={fieldTree}
              selectedSet={selectedSet}
              selectablePathSet={selectablePathSet}
              updateByPaths={updateByPaths}
              getNodeLabel={getNodeLabel}
              onToggle={toggleField}
            />
            <div className={styles.fieldTreeBrace}>{'}'}</div>
          </div>
        ) : (
          <div className={styles.noFieldsHint}>暂无可用字段，请先获取输入数据</div>
        )}
      </div>
    </div>
  );
}

function MapConfigEditor({
  config, onChange, availableFields,
}: {
  config: MapNodeConfig;
  onChange: (c: MapNodeConfig) => void;
  availableFields: string[];
}) {
  const addMapping = () => onChange({ ...config, mappings: [...config.mappings, { from: '', to: '' }] });
  const updateMapping = (i: number, field: 'from' | 'to', val: string) => {
    const m = [...config.mappings];
    const previous = m[i];
    m[i] = { ...m[i], [field]: val };

    if (field === 'to' && previous?.to && previous.to !== val) {
      for (let idx = i + 1; idx < m.length; idx++) {
        m[idx] = {
          ...m[idx],
          from: rebasePathPrefix(m[idx].from, previous.to, val),
          to: rebasePathPrefix(m[idx].to, previous.to, val),
        };
      }
    }

    onChange({ ...config, mappings: m });
  };
  const removeMapping = (i: number) => onChange({ ...config, mappings: config.mappings.filter((_, idx) => idx !== i) });
  const effectiveFieldOptionsByRow = useMemo(
    () => config.mappings.map((_, index) => projectFieldPathsByMappings(availableFields, config.mappings.slice(0, index))),
    [availableFields, config.mappings]
  );

  return (
    <div className={styles.configSection}>
      <div className={styles.configSectionTitle}>映射规则</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {config.mappings.map((m, i) => (
          <div key={i} className={styles.configRow}>
            <select value={m.from} onChange={(e) => updateMapping(i, 'from', e.target.value)}
              className="form-select" style={{ flex: 1, fontSize: 13 }}>
              <option value="">选择原字段</option>
              {(effectiveFieldOptionsByRow[i] || availableFields).map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', color: 'var(--color-text-muted)' }}>
              <Icons.ChevronRight size={14} />
            </div>
            <input type="text" value={m.to} onChange={(e) => updateMapping(i, 'to', e.target.value)}
              className="form-input" placeholder="新字段名" style={{ flex: 1, fontSize: 13 }} />
            <button className={styles.configRemoveBtn} onClick={() => removeMapping(i)} title="删除映射规则">
              <Icons.Trash size={16} />
            </button>
          </div>
        ))}
      </div>
      <button className={styles.configAddBtn} onClick={addMapping}>
        <Icons.Plus size={16} />
        添加映射规则
      </button>
      <div className={styles.formHelperText}>
        映射按顺序执行。若前一条规则把父级字段改名，后续规则的“原字段”下拉会自动跟随新的路径空间；修改父级目标名时，后续子级规则也会联动更新。
      </div>
    </div>
  );
}

function ComputeConfigEditor({
  config, onChange, availableFields, customParams,
}: {
  config: ComputeNodeConfig;
  onChange: (c: ComputeNodeConfig) => void;
  availableFields: string[];
  customParams: CustomParamDef[];
}) {
  const addComp = () => onChange({ ...config, computations: [...config.computations, { field: '', expression: '', sourceField: '' }] });
  const updateComp = (i: number, key: string, val: string) => {
    const c = [...config.computations]; c[i] = { ...c[i], [key]: val };
    onChange({ ...config, computations: c });
  };
  const removeComp = (i: number) => onChange({ ...config, computations: config.computations.filter((_, idx) => idx !== i) });
  const arrayFieldExamples = useMemo(
    () => availableFields.filter((field) => field.includes('[].')).slice(0, 4),
    [availableFields]
  );
  const arrayPrefixes = useMemo(() => extractArrayPrefixes(availableFields), [availableFields]);
  const applyArrayPrefix = (index: number, prefix: string) => {
    if (!prefix) return;
    const currentField = config.computations[index]?.field || '';
    const currentSuffix = currentField.includes('[].')
      ? currentField.slice(currentField.indexOf('[].') + 3)
      : currentField;
    updateComp(index, 'field', `${prefix}[].${currentSuffix || 'newField'}`);
  };

  return (
    <div className={styles.configSection}>
      <div className={styles.configSectionTitle}>计算规则</div>
      {config.computations.map((c, i) => (
        <div key={i} className={styles.computeBlock}>
          <div style={{ position: 'absolute', right: 12, top: 12 }}>
            <button className={styles.configRemoveBtn} onClick={() => removeComp(i)} title="删除计算规则">
              <Icons.Trash size={16} />
            </button>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>新字段名</label>
            <div className={styles.fieldInputRow}>
              <input type="text" value={c.field} onChange={(e) => updateComp(i, 'field', e.target.value)}
                className="form-input" placeholder="例如: totalPrice 或 userlist[].sex" style={{ fontSize: 13 }} />
              {arrayPrefixes.length > 0 && (
                <select
                  className="form-select"
                  value=""
                  onChange={(e) => {
                    applyArrayPrefix(i, e.target.value);
                    e.target.value = '';
                  }}
                  style={{ width: 176, fontSize: 12 }}
                >
                  <option value="">快捷填充数组路径</option>
                  {arrayPrefixes.map((prefix) => (
                    <option key={prefix} value={prefix}>{prefix}[].*</option>
                  ))}
                </select>
              )}
            </div>
            <div className={styles.formHelperText}>
              普通对象字段直接写 `totalPrice`；写入数组每一项时请使用 `列表路径[].字段名`，例如 `userlist[].sex`
            </div>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>数据来源 (可选)</label>
            <select value={c.sourceField || ''} onChange={(e) => updateComp(i, 'sourceField', e.target.value)}
              className="form-select" style={{ fontSize: 13 }}>
              <option value="">复制来源字段...</option>
              {availableFields.map(f => <option key={f} value={f}>{f}</option>)}
              {customParams.map(p => <option key={`param-direct:${p.key}`} value={p.key}>📌 入参直取: {p.key}</option>)}
              {customParams.map(p => <option key={`param:${p.key}`} value={`$param.${p.key}`}>📌 入参: {p.key}</option>)}
            </select>
          </div>
          <div className={styles.formGroup} style={{ marginBottom: 0 }}>
            <label className={styles.formLabel}>计算表达式</label>
            <input type="text" value={c.expression} onChange={(e) => updateComp(i, 'expression', e.target.value)}
              className="form-input" placeholder="如 {{price}} * {{count}}" style={{ fontSize: 13 }} />
          </div>
        </div>
      ))}
      <button className={styles.configAddBtn} onClick={addComp}>
        <Icons.Plus size={16} />
        添加计算字段
      </button>
      <div className={styles.computeHint}>
        <Icons.Info size={16} />
        <div>
          <strong>表达式支持模板语法：</strong><br />
          使用 <code>{`{{字段}}`}</code> 引用接口字段，<code>{`{{$param.入参key}}`}</code> 引用入参。支持基本算术运算。
          <br />
          写入数组项请把目标字段写成 <code>{`list[].field`}</code>；表达式会对数组里的每一项分别执行。
          {arrayFieldExamples.length > 0 && (
            <>
              <br />
              当前可参考的数组字段示例：<code>{arrayFieldExamples.join(', ')}</code>
            </>
          )}
        </div>
      </div>
    </div>
  );
}



function SortConfigEditor({
  config, onChange, availableFields, arrayFieldOptions,
}: {
  config: SortNodeConfig;
  onChange: (c: SortNodeConfig) => void;
  availableFields: string[];
  arrayFieldOptions: ArrayFieldOption[];
}) {
  const normalizedArrayPath = normalizePath(config.arrayPath || '');
  const selectedArray = arrayFieldOptions.find(option => normalizePath(option.arrayPath) === normalizedArrayPath);
  const sortFields = selectedArray?.itemFields || availableFields;
  const normalizedSortField = normalizeSortFieldValue(config.sortField || '', config.arrayPath || '');

  useEffect(() => {
    if (config.sortField && config.sortField !== normalizedSortField) {
      onChange({ ...config, sortField: normalizedSortField });
    }
  }, [config, normalizedSortField, onChange]);

  const handleArrayPathChange = (value: string) => {
    const normalizedNextPath = normalizePath(value);
    const nextArray = arrayFieldOptions.find(option => normalizePath(option.arrayPath) === normalizedNextPath);
    const currentSortField = normalizeSortFieldValue(config.sortField || '', value);
    const nextSortField = nextArray && currentSortField && !nextArray.itemFields.includes(currentSortField)
      ? ''
      : currentSortField;
    onChange({ ...config, arrayPath: value, sortField: nextSortField });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className={styles.formGroup}>
        <label className={styles.formLabel}>目标数组路径</label>
        {arrayFieldOptions.length > 0 ? (
          <select
            value={config.arrayPath}
            onChange={(e) => handleArrayPathChange(e.target.value)}
            className="form-select"
            style={{ fontSize: 13 }}
          >
            <option value="">(根数组)</option>
            {arrayFieldOptions.map(option => (
              <option key={option.arrayPath || '__root'} value={option.arrayPath}>
                {option.arrayPath || '(根数组)'}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={config.arrayPath}
            onChange={(e) => handleArrayPathChange(e.target.value)}
            className="form-input"
            placeholder="留空表示根数组，或如 data.items"
            style={{ fontSize: 13 }}
          />
        )}
        {selectedArray && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-primary)', fontWeight: 500 }}>
            <Icons.Check size={10} style={{ marginRight: 4 }} />
            当前识别到路径下的字段
          </div>
        )}
        <div className={styles.formHelperText}>
          这里填写数组本身的路径，例如 `userlist` 或 `data.items`；不要把字段名一起写进来。
        </div>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>排序字段</label>
        <select value={normalizedSortField} onChange={(e) => onChange({ ...config, sortField: e.target.value })}
          className="form-select" style={{ fontSize: 13 }}>
          <option value="">请选择排序字段...</option>
          {sortFields.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className={styles.formHelperText}>
          这里只填数组项内部字段，例如选择了 `userlist` 后，这里应填 `age`，而不是 `userlist[].age`
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className={styles.formGroup} style={{ marginBottom: 0 }}>
          <label className={styles.formLabel}>排序方向</label>
          <select value={config.order} onChange={(e) => onChange({ ...config, order: e.target.value as 'asc' | 'desc' })}
            className="form-select" style={{ fontSize: 13 }}>
            <option value="asc">升序 (ASC)</option>
            <option value="desc">降序 (DESC)</option>
          </select>
        </div>
        <div className={styles.formGroup} style={{ marginBottom: 0 }}>
          <label className={styles.formLabel}>结果限制</label>
          <input type="number" value={config.limit || ''} onChange={(e) => onChange({ ...config, limit: e.target.value ? parseInt(e.target.value) : undefined })}
            className="form-input" placeholder="不限制数量" style={{ fontSize: 13 }} min={1} />
        </div>
      </div>
    </div>
  );
}


// ============================================
// Node Summary
// ============================================

function NodeSummary({ node }: { node: OrchestrationNode }) {
  switch (node.type) {
    case 'filter': {
      const cfg = node.config as FilterNodeConfig;
      return (
        <div className={styles.nodeSummary}>
          <div className={styles.nodeSummaryItem}>
            <span className={styles.nodeSummaryKey}>{cfg.mode === 'include' ? '保留' : '排除'}:</span>
            <span className={styles.nodeSummaryValue}>{cfg.fields.length > 0 ? cfg.fields.slice(0, 3).join(', ') + (cfg.fields.length > 3 ? '...' : '') : '未配置'}</span>
          </div>
        </div>
      );
    }
    case 'map': {
      const cfg = node.config as MapNodeConfig;
      return (
        <div className={styles.nodeSummary}>
          {cfg.mappings.length > 0 ? cfg.mappings.slice(0, 2).map((m, i) => (
            <div key={i} className={styles.nodeSummaryItem}>
              <span className={styles.nodeSummaryValue}>{m.from || '?'}</span>
              <Icons.ChevronRight size={10} style={{ opacity: 0.5 }} />
              <span className={styles.nodeSummaryValue}>{m.to || '?'}</span>
            </div>
          )) : <div className={styles.nodeSummaryItem}><span className={styles.nodeSummaryKey}>未配置</span></div>}
          {cfg.mappings.length > 2 && <div className={styles.nodeSummaryItem}><span className={styles.nodeSummaryKey}>+{cfg.mappings.length - 2} more</span></div>}
        </div>
      );
    }
    case 'compute': {
      const cfg = node.config as ComputeNodeConfig;
      return (
        <div className={styles.nodeSummary}>
          {cfg.computations.length > 0 ? cfg.computations.slice(0, 2).map((c, i) => (
            <div key={i} className={styles.nodeSummaryItem}>
              <span className={styles.nodeSummaryValue}>{c.field || '?'}</span>
              <span className={styles.nodeSummaryKey}>=</span>
              <span className={styles.nodeSummaryValue} style={{ maxWidth: 80 }}>{c.sourceField || c.expression || '?'}</span>
            </div>
          )) : <div className={styles.nodeSummaryItem}><span className={styles.nodeSummaryKey}>未配置</span></div>}
        </div>
      );
    }
    case 'sort': {
      const cfg = node.config as SortNodeConfig;
      return (
        <div className={styles.nodeSummary}>
          <div className={styles.nodeSummaryItem}>
            <span className={styles.nodeSummaryKey}>排序:</span>
            <span className={styles.nodeSummaryValue}>{cfg.sortField || '未设置'} {cfg.order === 'asc' ? '↑' : '↓'}</span>
          </div>
          {cfg.limit && <div className={styles.nodeSummaryItem}><span className={styles.nodeSummaryKey}>限制:</span><span className={styles.nodeSummaryValue}>{cfg.limit} 条</span></div>}
        </div>
      );
    }
  }
}

// ============================================
// Full-screen Orchestration Workspace
// ============================================

interface ForwardConfigRef {
  method: string;
  path: string;
  targetType: ApiForwardTargetType;
  targetId: string;
  paramBindings: ParamBinding[];
  customParams: CustomParamDef[];
}

function OrchestrationWorkspace({
  config,
  onChange,
  onSave,
  onClose,
  forwardConfig,
  customParams,
  runParams,
}: {
  config: OrchestrationConfig;
  onChange: (config: OrchestrationConfig) => void;
  onSave?: (config?: OrchestrationConfig) => Promise<void> | void;
  onClose: () => void;
  forwardConfig: ForwardConfigRef;
  customParams: CustomParamDef[];
  runParams: Record<string, string>;
}) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [inputData, setInputData] = useState<unknown>(null);
  const [inputLoading, setInputLoading] = useState(false);
  const [previewParams, setPreviewParams] = useState<Record<string, string>>(
    () => buildPreviewParams(customParams, runParams)
  );
  const [debugResult, setDebugResult] = useState<unknown>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'input' | 'config' | 'output'>('input');
  const [previewHeight, setPreviewHeight] = useState(320);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [modelProfiles, setModelProfiles] = useState<AIModelProfile[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [activeModelKey, setActiveModelKey] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelReminderOpen, setModelReminderOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<AiChatMessage[]>([
    {
      id: generateChatMessageId(),
      role: 'assistant',
      content: '我可以根据接口 output、当前编排 scheme、节点格式和入参定义，直接帮你生成或修改工作流配置。',
    },
  ]);
  const isResizing = useRef(false);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const newHeight = window.innerHeight - e.clientY;
    // Set boundaries for the preview height (min 150px, max 80% of window height)
    if (newHeight > 150 && newHeight < window.innerHeight * 0.8) {
      setPreviewHeight(newHeight);
    }
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', stopResizing);
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, [handleMouseMove]);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResizing);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [handleMouseMove, stopResizing]);

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', stopResizing);
    };
  }, [handleMouseMove, stopResizing]);

  useEffect(() => {
    if (!chatOpen) return;
    chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatOpen]);

  useEffect(() => {
    if (!chatOpen) {
      setModelPickerOpen(false);
    }
  }, [chatOpen]);

  const loadModelProfiles = useCallback(async () => {
    try {
      setModelLoading(true);
      const res = await fetch('/api/ai-models');
      if (!res.ok) {
        throw new Error('获取模型配置失败');
      }
      const data = await res.json() as AIModelProfile[];
      setModelProfiles(data);
      return data;
    } catch (error) {
      setChatMessages((prev) => (
        prev.some((item) => item.error && item.content.includes('获取模型配置失败'))
          ? prev
          : [
              ...prev,
              {
                id: generateChatMessageId(),
                role: 'assistant',
                content: error instanceof Error ? error.message : '获取模型配置失败',
                error: true,
              },
            ]
      ));
      return [];
    } finally {
      setModelLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelProfiles();
  }, [loadModelProfiles]);

  const nodes = config?.nodes || [];
  const sortedNodes = [...nodes].sort((a, b) => a.order - b.order);
  const editingNode = editingNodeId ? nodes.find(n => n.id === editingNodeId) : null;
  const debugHasError = isObjectLike(debugResult) && 'error' in debugResult;
  const configJsonPreview = useMemo(() => JSON.stringify({ nodes: sortedNodes }, null, 2), [sortedNodes]);
  const originalInputFields = useMemo(
    () => (inputData ? extractFieldPaths(inputData) : []),
    [inputData]
  );
  const rootArrayFieldOptions = useMemo(
    () => (inputData ? extractArrayFieldOptions(inputData) : []),
    [inputData]
  );
  const validationIssues = useMemo(
    () => validateWorkflowConfig({ nodes: sortedNodes }, rootArrayFieldOptions),
    [sortedNodes, rootArrayFieldOptions]
  );
  const validationErrorCount = validationIssues.filter((issue) => issue.severity === 'error').length;
  const modelOptions = useMemo(() => flattenAIModelSelections(modelProfiles, 'chat'), [modelProfiles]);
  const defaultModelOption = useMemo(() => getDefaultAIModelSelection(modelProfiles, 'chat'), [modelProfiles]);
  const activeModel = useMemo(() => {
    const matched = modelOptions.find((item) => getAIModelSelectionKey(item) === activeModelKey);
    return matched || defaultModelOption || null;
  }, [activeModelKey, defaultModelOption, modelOptions]);
  useEffect(() => {
    if (modelOptions.length === 0) {
      setActiveModelKey(null);
      return;
    }

    if (activeModelKey && modelOptions.some((item) => getAIModelSelectionKey(item) === activeModelKey)) {
      return;
    }

    if (defaultModelOption) {
      setActiveModelKey(getAIModelSelectionKey(defaultModelOption));
      return;
    }

    setActiveModelKey(getAIModelSelectionKey(modelOptions[0]));
  }, [activeModelKey, defaultModelOption, modelOptions]);
  const focusNode = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
    setActiveTab('config');
    setChatOpen(false);
    setModelPickerOpen(false);
    requestAnimationFrame(() => {
      const nodeElement = document.querySelector(`[data-node-id="${nodeId}"]`);
      if (nodeElement instanceof HTMLElement) {
        nodeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    });
  }, []);

  // 获取输入数据
  const fetchInputData = useCallback(async (): Promise<unknown | null> => {
    if (!forwardConfig.targetId) return null;
    setInputLoading(true);
    try {
      const res = await fetch('/api/forwards/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forwardConfig: {
            id: 'preview',
            name: 'preview',
            apiGroup: '',
            description: '',
            method: forwardConfig.method,
            path: forwardConfig.path,
            customParams: forwardConfig.customParams,
            targetType: forwardConfig.targetType,
            targetId: forwardConfig.targetId,
            paramBindings: forwardConfig.paramBindings,
            createdAt: '', updatedAt: '',
          },
          runParams: previewParams,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        const nextInputData = result.data || result;
        setInputData(nextInputData);
        return nextInputData;
      }
      return null;
    } catch (err) {
      console.error('Failed to fetch input data', err);
      return null;
    } finally {
      setInputLoading(false);
    }
  }, [forwardConfig, previewParams]);

  useEffect(() => {
    fetchInputData();
  }, [fetchInputData]);

  useEffect(() => {
    setPreviewParams(buildPreviewParams(customParams, runParams));
  }, [customParams, runParams]);

  const getNodeInputData = useCallback((nodeId: string): unknown => {
    const idx = sortedNodes.findIndex(n => n.id === nodeId);
    if (idx <= 0) return inputData;
    
    // We would ideally use pre-computed outputs, but for simplicity in editor
    // we re-run engine for current node's input context if needed.
    let current = inputData;
    for (let i = 0; i < idx; i++) {
      try {
        current = applyNode(current, sortedNodes[i], previewParams);
      } catch { break; }
    }
    return current;
  }, [sortedNodes, inputData, previewParams]);

  const getAvailableFields = useCallback((nodeId: string): string[] => {
    const nodeInputData = getNodeInputData(nodeId);
    return nodeInputData ? extractFieldPaths(nodeInputData) : [];
  }, [getNodeInputData]);

  const getArrayFieldOptions = useCallback((nodeId: string): ArrayFieldOption[] => {
    const nodeInputData = getNodeInputData(nodeId);
    return nodeInputData ? extractArrayFieldOptions(nodeInputData) : [];
  }, [getNodeInputData]);

  const updateNodes = useCallback((newNodes: OrchestrationNode[]) => {
    onChange({ ...config, nodes: newNodes });
  }, [config, onChange]);

  const addNode = (type: OrchestrationNodeType) => {
    const newNode: OrchestrationNode = {
      id: generateNodeId(), type,
      label: NODE_TYPE_META[type].label,
      config: createDefaultConfig(type),
      order: nodes.length,
    };
    updateNodes([...nodes, newNode]);
    setEditingNodeId(newNode.id);
  };

  const removeNode = (id: string) => {
    const filtered = nodes.filter(n => n.id !== id);
    updateNodes(filtered.map((n, i) => ({ ...n, order: i })));
    if (editingNodeId === id) setEditingNodeId(null);
  };

  const updateNodeConfig = (id: string, newConfig: OrchestrationNode['config']) => {
    updateNodes(nodes.map(n => n.id === id ? { ...n, config: newConfig } : n));
  };

  const updateNodeLabel = (id: string, label: string) => {
    updateNodes(nodes.map(n => n.id === id ? { ...n, label } : n));
  };

  const debugNode = async (nodeId: string) => {
    if (!inputData) { await fetchInputData(); return; }
    setDebugLoading(true);
    setDebugResult(null);
    setActiveTab('output');
    try {
      const res = await fetch('/api/forwards/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleData: inputData,
          orchestration: { nodes: sortedNodes },
          context: previewParams,
          mode: 'upto', nodeId,
        }),
      });
      const data = await res.json();
      setDebugResult(data);
    } catch (err) {
      setDebugResult({ error: err instanceof Error ? err.message : '节点调试失败' });
    } finally {
      setDebugLoading(false);
    }
  };

  const runFullPipeline = async () => {
    if (!inputData) { await fetchInputData(); return; }
    setDebugLoading(true);
    setDebugResult(null);
    setActiveTab('output');
    try {
      const res = await fetch('/api/forwards/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleData: inputData,
          orchestration: { nodes: sortedNodes },
          context: previewParams,
          mode: 'full',
        }),
      });
      const data = await res.json();
      setDebugResult(data);
    } catch (err) {
      setDebugResult({ error: err instanceof Error ? err.message : '编排执行失败' });
    } finally {
      setDebugLoading(false);
    }
  };

  const saveWorkflowConfig = async () => {
    if (!onSave) return;
    const normalized = normalizeWorkflowConfig({ nodes: sortedNodes });
    const normalizedIssues = validateWorkflowConfig(normalized.config, rootArrayFieldOptions);
    if (normalized.changes.length > 0) {
      updateNodes(normalized.config.nodes);
      setSaveNotice(normalized.changes.join('；'));
    } else {
      setSaveNotice(null);
    }

    const blockingIssues = normalizedIssues.filter((issue) => issue.severity === 'error');
    if (blockingIssues.length > 0) {
      setSaveNotice(`发现 ${blockingIssues.length} 个需要先修复的问题`);
      return;
    }

    setSaveLoading(true);
    try { await onSave(normalized.config); } finally { setSaveLoading(false); }
  };

  const openChatPanel = async () => {
    const profiles = modelProfiles.length > 0 ? modelProfiles : await loadModelProfiles();
    const nextDefault = getDefaultAIModelSelection(profiles, 'chat');
    if (!nextDefault) {
      setModelReminderOpen(true);
      return;
    }

    if (!activeModelKey) {
      setActiveModelKey(getAIModelSelectionKey(nextDefault));
    }

    setModelReminderOpen(false);
    setChatOpen(true);
  };

  const sendChatMessage = async (preset?: string, mode: AiChatMode = 'general') => {
    const content = (preset ?? chatInput).trim();
    if (!content || chatLoading) return;
    if (!activeModel) {
      setModelReminderOpen(true);
      return;
    }

    const blockingValidationIssues = validationIssues.filter((issue) => issue.severity === 'error');
    if (mode === 'fix-validation' && blockingValidationIssues.length === 0) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: generateChatMessageId(),
          role: 'assistant',
          content: '当前没有体检报错需要修复。若你想顺手优化 warning，可以直接使用常规 AI Chat。',
        },
      ]);
      setChatOpen(true);
      return;
    }

    const nextUserMessage: AiChatMessage = {
      id: generateChatMessageId(),
      role: 'user',
      content: mode === 'fix-validation' ? `[只修复体检报错模式]\n${content}` : content,
    };

    const nextConversation = [
      ...chatMessages.map((message) => ({ role: message.role, content: message.content })),
      { role: nextUserMessage.role, content: nextUserMessage.content },
    ];
    const assistantMessageId = generateChatMessageId();
    const previousConfigSnapshot: OrchestrationConfig = { nodes: sortedNodes };

    setChatMessages((prev) => [
      ...prev,
      nextUserMessage,
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '正在理解你的需求并生成工作流配置...',
      },
    ]);
    setChatInput('');
    setChatLoading(true);
    setChatOpen(true);

    try {
      const sampleOutput = inputData ?? await fetchInputData();
      const res = await fetch('/api/forwards/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: true,
          mode,
          messages: nextConversation,
          currentConfig: { nodes: sortedNodes },
          sampleOutput,
          customParams,
          runParams: previewParams,
          forwardConfig,
          selectedModel: activeModel,
          validationIssues: mode === 'fix-validation' ? blockingValidationIssues : validationIssues,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        try {
          const errorData = errorText ? JSON.parse(errorText) as { error?: string } : {};
          throw new Error(errorData.error || 'AI 编排请求失败');
        } catch {
          throw new Error(errorText || 'AI 编排请求失败');
        }
      }

      if (!res.body) {
        throw new Error('AI 流式响应不可用');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalMessage = '';
      let finalConfig: OrchestrationConfig | null = null;
      let previewText = '';

      const updateAssistantMessage = (message: string, error = false, diffLines?: string[]) => {
        setChatMessages((prev) => prev.map((item) => (
          item.id === assistantMessageId
            ? { ...item, content: message, error, diffLines }
            : item
        )));
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.rest;

        for (const block of parsed.events) {
          const payload = JSON.parse(block.data) as Record<string, unknown>;

          if (block.event === 'delta') {
            const chunk = typeof payload.content === 'string' ? payload.content : '';
            if (!chunk) continue;
            previewText += chunk;
            updateAssistantMessage(previewText);
            continue;
          }

          if (block.event === 'done') {
            finalMessage = typeof payload.message === 'string'
              ? payload.message
              : '已根据你的要求更新工作流，并同步渲染到工作流画布。';
            const rawConfig = payload.config && typeof payload.config === 'object'
              ? payload.config as OrchestrationConfig
              : { nodes: [] };
            const normalized = normalizeWorkflowConfig(rawConfig);
            const aiArrayFieldOptions = sampleOutput ? extractArrayFieldOptions(sampleOutput) : rootArrayFieldOptions;
            const aiIssues = validateWorkflowConfig(normalized.config, aiArrayFieldOptions);
            const notes: string[] = [];
            if (normalized.changes.length > 0) {
              notes.push(normalized.changes.join('；'));
            }
            if (aiIssues.length > 0) {
              const topIssues = aiIssues.slice(0, 3).map((issue) => issue.message).join('；');
              notes.push(`体检发现 ${aiIssues.length} 项问题：${topIssues}${aiIssues.length > 3 ? '…' : ''}`);
            }
            finalConfig = normalized.config;
            updateAssistantMessage(
              notes.length > 0 ? `${finalMessage}\n\n${notes.join('\n')}` : finalMessage,
              false,
              summarizeWorkflowDiff(previousConfigSnapshot, normalized.config)
            );
            continue;
          }

          if (block.event === 'error') {
            throw new Error(typeof payload.error === 'string' ? payload.error : 'AI 流式响应处理失败');
          }
        }
      }

      if (finalConfig) {
        updateNodes(finalConfig.nodes);
        const nextIssues = validateWorkflowConfig(finalConfig, sampleOutput ? extractArrayFieldOptions(sampleOutput) : rootArrayFieldOptions);
        const focusTargetId = nextIssues[0]?.nodeId || finalConfig.nodes[0]?.id || null;
        if (focusTargetId) {
          focusNode(focusTargetId);
        } else {
          setEditingNodeId(null);
          setActiveTab('config');
        }
      } else {
        throw new Error('AI 未返回最终工作流配置');
      }
    } catch (err) {
      setChatMessages((prev) => prev.map((item) => (
        item.id === assistantMessageId
          ? { ...item, content: err instanceof Error ? err.message : 'AI 编排请求失败', error: true }
          : item
      )));
    } finally {
      setChatLoading(false);
    }
  };

  const handleDragStart = (e: React.DragEvent, nodeId: string) => {
    setDragNodeId(nodeId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleDrop = (e: React.DragEvent, targetNodeId: string) => {
    e.preventDefault();
    if (!dragNodeId || dragNodeId === targetNodeId) return;
    const dragIdx = sortedNodes.findIndex(n => n.id === dragNodeId);
    const targetIdx = sortedNodes.findIndex(n => n.id === targetNodeId);
    if (dragIdx === -1 || targetIdx === -1) return;
    const reordered = [...sortedNodes];
    const [removed] = reordered.splice(dragIdx, 1);
    reordered.splice(targetIdx, 0, removed);
    updateNodes(reordered.map((n, i) => ({ ...n, order: i })));
    setDragNodeId(null);
  };

  return (
    <div className={styles.workspaceOverlay}>
      <div className={styles.workspace}>
        {/* Top Bar */}
        <div className={styles.workspaceTopBar}>
          <div className={styles.topBarLeft}>
            <button className={styles.backBtn} onClick={onClose}>
              <Icons.X size={14} /> 返回配置
            </button>
            <div className={styles.topBarTitle}>
              <Icons.Settings className={styles.topBarIcon} size={20} />
              高级编排工作流
            </div>
          </div>
          <div className={styles.topBarRight}>
            {customParams.length > 0 && (
              <div className={styles.paramsBadge}>
                <Icons.Info size={14} /> 可用入参: {customParams.map(p => p.key).join(', ')}
              </div>
            )}
            {validationIssues.length > 0 && (
              <div className={styles.warningBadge}>
                <Icons.AlertTriangle size={14} />
                体检发现 {validationIssues.length} 项问题{validationErrorCount > 0 ? `，其中 ${validationErrorCount} 项需先修复` : ''}
              </div>
            )}
            {saveNotice && (
              <div className={styles.noticeBadge}>
                <Icons.Check size={14} /> {saveNotice}
              </div>
            )}
            <button className={styles.refreshBtn} onClick={fetchInputData} disabled={inputLoading}>
              <Icons.Refresh className={inputLoading ? 'animate-spin' : ''} size={14} />
              {inputLoading ? '获取中...' : '刷新数据'}
            </button>
            <button
              className={`${styles.runBtn} ${debugLoading ? styles.running : ''}`}
              onClick={runFullPipeline}
              disabled={debugLoading || nodes.length === 0}
            >
              <Icons.Activity size={14} />
              {debugLoading ? '执行中...' : '编排试运行'}
            </button>
            <button className={styles.saveBtn} onClick={saveWorkflowConfig} disabled={saveLoading}>
              <Icons.Check size={14} />
              {saveLoading ? '保存中...' : '保存编排'}
            </button>
          </div>
        </div>

        {validationIssues.length > 0 && (
          <div className={styles.validationPanel}>
            {validationIssues.map((issue, index) => (
              <button
                key={`${issue.message}-${index}`}
                type="button"
                className={`${styles.validationItem} ${issue.severity === 'error' ? styles.error : styles.warning} ${issue.nodeId ? styles.clickable : ''}`}
                onClick={() => issue.nodeId && focusNode(issue.nodeId)}
                disabled={!issue.nodeId}
              >
                <Icons.AlertTriangle size={14} />
                <span>{issue.message}</span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.workspaceBody}>
          <div className={styles.canvasArea}>
            {/* Node Toolbar */}
            <div className={styles.canvasToolbar}>
              <span className={styles.toolbarLabel}>添加处理节点:</span>
              {(Object.entries(NODE_TYPE_META) as [OrchestrationNodeType, typeof NODE_TYPE_META[OrchestrationNodeType]][]).map(([type, meta]) => (
                <button key={type} className={styles.addNodeBtn} onClick={() => addNode(type)}>
                  <span className={styles.nodeTypeIcon}>{meta.icon}</span>
                  {meta.label}
                </button>
              ))}
              <div className={styles.toolbarSpacer} />
              <button
                className={`${styles.addNodeBtn} ${styles.chatTriggerBtn}`}
                onClick={() => void openChatPanel()}
                title="打开 AI Chat 对话页"
              >
                <Icons.MessageSquare size={14} />
                AI Chat
              </button>
            </div>

            {/* Pipeline Canvas */}
            {nodes.length === 0 ? (
              <div className={styles.pipelineEmpty}>
                <div className={styles.emptyIcon}><Icons.Layers size={56} /></div>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>开始构建您的管线</div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 8 }}>
                  添加节点来筛选、映射或计算您的API返回数据
                </div>
              </div>
            ) : (
              <div className={styles.pipeline}>
                <div className={`${styles.endpointBox} ${styles.input}`}>
                  <span className={styles.endpointIcon}><Icons.Server size={24} /></span>
                  <span className={styles.endpointLabel}>INPUT</span>
                </div>
                {sortedNodes.map((node, index) => (
                  <div key={node.id} style={{ display: 'flex', alignItems: 'center' }}>
                    <div className={styles.connector}><div className={styles.connectorLine} /></div>
                    <div
                      className={`${styles.nodeCard} ${editingNodeId === node.id ? styles.active : ''} ${dragNodeId === node.id ? styles.dragging : ''}`}
                      data-node-id={node.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, node.id)}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, node.id)}
                      onDragEnd={() => setDragNodeId(null)}
                      onClick={() => setEditingNodeId(editingNodeId === node.id ? null : node.id)}
                    >
                      <span className={styles.nodeOrderBadge}>{index + 1}</span>
                      <div className={styles.nodeCardHeader}>
                        <span className={`${styles.nodeTypeTag} ${styles[NODE_TYPE_META[node.type].color]}`}>
                          {NODE_TYPE_META[node.type].icon} {node.label || NODE_TYPE_META[node.type].label}
                        </span>
                        <div className={styles.nodeActions}>
                          <button className={`${styles.nodeActionBtn} ${styles.debug}`}
                            onClick={(e) => { e.stopPropagation(); debugNode(node.id); }} title="调试到此"><Icons.Activity size={12} /></button>
                          <button className={`${styles.nodeActionBtn} ${styles.delete}`}
                            onClick={(e) => { e.stopPropagation(); removeNode(node.id); }} title="删除"><Icons.Trash size={12} /></button>
                        </div>
                      </div>
                      <div className={styles.nodeCardBody}><NodeSummary node={node} /></div>
                    </div>
                  </div>
                ))}
                <div className={styles.connector}><div className={styles.connectorLine} /></div>
                <div className={`${styles.endpointBox} ${styles.output}`}>
                  <span className={styles.endpointIcon}><Icons.Monitor size={24} /></span>
                  <span className={styles.endpointLabel}>OUTPUT</span>
                </div>
              </div>
            )}

            {/* Bottom Data Preview */}
            <div className={styles.dataPreviewArea} style={{ height: previewHeight }}>
              <div className={styles.resizer} onMouseDown={startResizing}>
                <div className={styles.resizerHandle} />
              </div>
              <div className={styles.dataPreviewTabs}>
                <div className={`${styles.dataPreviewTab} ${activeTab === 'input' ? styles.active : ''}`} onClick={() => setActiveTab('input')}>
                  <Icons.Server size={14} style={{ marginRight: 6 }} /> 输入数据
                </div>
                <div className={`${styles.dataPreviewTab} ${activeTab === 'config' ? styles.active : ''}`} onClick={() => setActiveTab('config')}>
                  <Icons.Code size={14} style={{ marginRight: 6 }} /> 配置 JSON
                </div>
                {debugResult !== null && (
                  <div className={`${styles.dataPreviewTab} ${activeTab === 'output' ? styles.active : ''}`} onClick={() => setActiveTab('output')}>
                    <Icons.Activity size={14} style={{ marginRight: 6 }} /> 编排输出
                  </div>
                )}
              </div>
              <div className={styles.dataPreviewContent}>
                {activeTab === 'input' && (
                  <div className={styles.inputTabContent}>
                    <div className={styles.inputSubSection}>
                      <div className={styles.subSectionHeader}>
                        <span><Icons.Edit size={12} style={{ marginRight: 6 }} /> 参数输入 (Parameter Input)</span>
                      </div>
                      {customParams.length > 0 ? (
                        <div className={styles.previewParamsPanel}>
                          <div className={styles.previewParamsGrid}>
                            {customParams.map((param) => (
                              <label key={param.key} className={styles.previewParamItem}>
                                <span className={styles.previewParamLabel}>{param.key}</span>
                                <input
                                  type={param.type === 'number' || param.type === 'integer' ? 'number' : 'text'}
                                  value={previewParams[param.key] || ''}
                                  onChange={(e) => setPreviewParams((prev) => ({ ...prev, [param.key]: e.target.value }))}
                                  className="form-input"
                                  placeholder={param.defaultValue || ''}
                                  style={{ fontSize: 12, height: 32 }}
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div style={{ padding: 20, color: 'var(--color-text-muted)', fontSize: 12, textAlign: 'center' }}>
                          未定义输入参数
                        </div>
                      )}
                    </div>
                    <div className={styles.inputSubSection}>
                      <div className={styles.subSectionHeader}>
                        <span><Icons.Server size={12} style={{ marginRight: 6 }} /> 接口输出 (Interface Output)</span>
                        <button className={styles.miniBtn} onClick={fetchInputData} disabled={inputLoading} title="刷新接口数据">
                          <Icons.Refresh className={inputLoading ? 'animate-spin' : ''} size={12} />
                        </button>
                      </div>
                      <pre className={styles.dataPreviewPre}>
                        {inputData ? JSON.stringify(inputData, null, 2) : (inputLoading ? '正在拉取实时数据...' : '请刷新以获取预览数据')}
                      </pre>
                    </div>
                  </div>
                )}
                {activeTab === 'config' && (
                  <div className={styles.dataPreviewPane}>
                    <pre className={styles.dataPreviewPre}>{configJsonPreview}</pre>
                  </div>
                )}
                {activeTab === 'output' && debugResult !== null && (
                  <div className={styles.dataPreviewPane} style={{ borderColor: debugHasError ? '#ef4444' : undefined }}>
                    <pre className={styles.dataPreviewPre}>
                      {JSON.stringify(debugResult, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Panel */}
          {editingNode && (
            <div className={styles.rightPanel}>
              <div className={styles.configHeader} style={{ padding: '16px 20px' }}>
                <div className={styles.configTitle}>
                  <div className={`${styles.nodeTypeTag} ${styles[NODE_TYPE_META[editingNode.type].color]}`} style={{ marginBottom: 4 }}>
                    {NODE_TYPE_META[editingNode.type].icon} {NODE_TYPE_META[editingNode.type].label}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>节点配置</div>
                </div>
                <button className={styles.configCloseBtn} onClick={() => setEditingNodeId(null)} title="关闭面板">
                  <Icons.X size={18} />
                </button>
              </div>
              
              <div className={styles.configBody} style={{ padding: '20px' }}>
                <div className={styles.configSection} style={{ marginBottom: 24 }}>
                  <div className={styles.configSectionTitle}>节点名称</div>
                  <input type="text" value={editingNode.label || ''} onChange={(e) => updateNodeLabel(editingNode.id, e.target.value)}
                    className="form-input" placeholder="自定义节点标签" style={{ fontSize: 13 }} />
                </div>

                <div className={styles.configSection}>
                  <div className={styles.configSectionTitle}>功能配置</div>
                  {editingNode.type === 'filter' && (
                    <FilterConfigEditor config={editingNode.config as FilterNodeConfig}
                      onChange={(c) => updateNodeConfig(editingNode.id, c)}
                      availableFields={originalInputFields} />
                  )}
                  {editingNode.type === 'map' && (
                    <MapConfigEditor config={editingNode.config as MapNodeConfig}
                      onChange={(c) => updateNodeConfig(editingNode.id, c)}
                      availableFields={getAvailableFields(editingNode.id)} />
                  )}
                  {editingNode.type === 'compute' && (
                    <ComputeConfigEditor config={editingNode.config as ComputeNodeConfig}
                      onChange={(c) => updateNodeConfig(editingNode.id, c)}
                      availableFields={getAvailableFields(editingNode.id)}
                      customParams={customParams} />
                  )}
                  {editingNode.type === 'sort' && (
                    <SortConfigEditor config={editingNode.config as SortNodeConfig}
                      onChange={(c) => updateNodeConfig(editingNode.id, c)}
                      availableFields={getAvailableFields(editingNode.id)}
                      arrayFieldOptions={getArrayFieldOptions(editingNode.id)} />
                  )}
                </div>
              </div>

              <div className={styles.configFooter} style={{ padding: '16px 20px' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => debugNode(editingNode.id)} disabled={debugLoading}>
                  <Icons.Activity size={12} style={{ marginRight: 6 }} />
                  调试节点
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setEditingNodeId(null)}>
                  <Icons.Check size={12} style={{ marginRight: 6 }} />
                  完成配置
                </button>
              </div>
            </div>
          )}

          {chatOpen && (
            <div className={styles.chatPanelOverlay}>
              <div className={styles.chatPanel}>
                <div className={styles.chatPanelHeader}>
                  <div>
                    <div className={styles.chatPanelTitle}>
                      <Icons.Sparkles size={16} />
                      AI Chat 对话页
                    </div>
                    <div className={styles.chatPanelDesc}>
                      基于当前编排 scheme、节点格式、参数定义和接口 output 生成工作流配置
                    </div>
                  </div>
                  <div className={styles.chatHeaderActions}>
                    <div className={styles.chatModelPicker}>
                      <button
                        className={styles.chatModelBtn}
                        type="button"
                        onClick={() => setModelPickerOpen((prev) => !prev)}
                        disabled={modelOptions.length === 0}
                        title={activeModel ? getModelOptionLabel(activeModel) : '选择模型'}
                      >
                        <Icons.Sparkles size={14} />
                        <span>{activeModel ? getModelOptionLabel(activeModel) : (modelLoading ? '读取模型中...' : '选择模型')}</span>
                      </button>
                      {modelPickerOpen && (
                        <div className={styles.chatModelMenu}>
                          <div className={styles.chatModelMenuHeader}>
                            <span>切换 AI 模型</span>
                            <button type="button" className={styles.chatModelRefreshBtn} onClick={() => void loadModelProfiles()}>
                              <Icons.Refresh size={12} />
                            </button>
                          </div>
                          {modelOptions.length > 0 ? modelOptions.map((option) => {
                            const optionKey = getAIModelSelectionKey(option);
                            const isActive = activeModelKey === optionKey || (!activeModelKey && option.isDefault);
                            return (
                              <button
                                key={optionKey}
                                type="button"
                                className={`${styles.chatModelOption} ${isActive ? styles.active : ''}`}
                                onClick={() => {
                                  setActiveModelKey(optionKey);
                                  setModelPickerOpen(false);
                                }}
                              >
                                <div>{option.profileName}</div>
                                <strong>{option.modelId}</strong>
                                {option.isDefault && <span>默认</span>}
                              </button>
                            );
                          }) : (
                            <div className={styles.chatModelEmpty}>还没有可用模型，请先去模型管理创建配置。</div>
                          )}
                        </div>
                      )}
                    </div>
                    <button className={styles.configCloseBtn} onClick={() => { setChatOpen(false); setModelPickerOpen(false); }} title="关闭 AI Chat">
                      <Icons.X size={18} />
                    </button>
                  </div>
                </div>

                <div className={styles.chatContextBar}>
                  <span>当前节点 {sortedNodes.length}</span>
                  <span>可用参数 {customParams.length}</span>
                  <span>{inputData ? '已加载 output' : '待加载 output'}</span>
                  <span>{activeModel ? `当前模型 ${activeModel.modelId}` : '未选择模型'}</span>
                </div>

                <div className={styles.chatSuggestionRow}>
                  {AI_CHAT_SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      className={styles.chatSuggestionBtn}
                      onClick={() => void sendChatMessage(suggestion)}
                      disabled={chatLoading}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>

                <div className={styles.chatMessages}>
                  {chatMessages.map((message) => (
                    <div
                      key={message.id}
                      className={`${styles.chatMessage} ${message.role === 'user' ? styles.user : styles.assistant} ${message.error ? styles.error : ''}`}
                    >
                      <div className={styles.chatMessageRole}>
                        {message.role === 'user' ? '你' : 'AI'}
                      </div>
                      <div className={styles.chatMessageBubble}>
                        {message.content}
                        {message.diffLines && message.diffLines.length > 0 && (
                          <div className={styles.chatDiffCard}>
                            <div className={styles.chatDiffTitle}>本次改动摘要</div>
                            {message.diffLines.map((line, index) => (
                              <div key={`${message.id}-diff-${index}`} className={styles.chatDiffItem}>
                                <span className={styles.chatDiffBullet}>•</span>
                                <span>{line}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className={`${styles.chatMessage} ${styles.assistant}`}>
                      <div className={styles.chatMessageRole}>AI</div>
                      <div className={styles.chatMessageBubble}>正在分析接口输出并生成可渲染的工作流配置...</div>
                    </div>
                  )}
                  <div ref={chatMessagesEndRef} />
                </div>

                <div className={styles.chatComposer}>
                  <textarea
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        void sendChatMessage();
                      }
                    }}
                    className={styles.chatTextarea}
                    placeholder="例如：保留 data.list 下的 id、name、status，新增 displayName 字段，并按 updatedAt 倒序只保留 10 条。"
                  />
                  <div className={styles.chatComposerFooter}>
                    <span className={styles.chatComposerHint}>Ctrl/Command + Enter 发送，并自动应用到画布</span>
                    <div className={styles.chatComposerActions}>
                      <button
                        className={styles.chatFixBtn}
                        onClick={() => void sendChatMessage(chatInput || '请仅修复当前体检报错，尽量少改动无关节点。', 'fix-validation')}
                        disabled={chatLoading || validationErrorCount === 0}
                        title={validationErrorCount === 0 ? '当前没有体检报错' : '仅修复当前体检报错'}
                      >
                        <Icons.AlertTriangle size={14} />
                        只修复体检报错
                      </button>
                      <button
                        className={styles.chatSendBtn}
                        onClick={() => void sendChatMessage()}
                        disabled={chatLoading || !chatInput.trim()}
                      >
                        <Icons.Send size={14} />
                        {chatLoading ? '生成中...' : '发送并应用'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {modelReminderOpen && (
            <div className={styles.chatPanelOverlay}>
              <div className={styles.modelReminderCard}>
                <div className={styles.modelReminderIcon}>
                  <Icons.Sparkles size={22} />
                </div>
                <div className={styles.modelReminderTitle}>请先配置 AI 模型</div>
                <div className={styles.modelReminderDesc}>
                  AI Chat 现在改为从“模型管理”中读取 OpenAI 兼容模型配置。请先添加至少一个模型来源，并设置默认 Model ID。
                </div>
                <div className={styles.modelReminderActions}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setModelReminderOpen(false)}
                  >
                    稍后再说
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      window.location.href = '/model-management';
                    }}
                  >
                    前往模型管理
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Main Export: Toggle + Workspace
// ============================================

export default function OrchestrationEditor({
  config, onChange, onSave, forwardConfig, customParams, runParams,
}: {
  config: OrchestrationConfig;
  onChange: (config: OrchestrationConfig) => void;
  onSave?: (config?: OrchestrationConfig) => Promise<void> | void;
  forwardConfig: ForwardConfigRef;
  customParams: CustomParamDef[];
  runParams: Record<string, string>;
}) {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const nodeCount = config?.nodes?.length || 0;

  return (
    <>
      <div className={styles.orchestrationEntry}>
        <div className={styles.entryLeft}>
          <div className={styles.entryIcon}><Icons.Settings size={20} /></div>
          <div className={styles.entryInfo}>
            <div className={styles.entryTitle}>高级数据编排</div>
            <div className={styles.entryDesc}>对接口返回结果进行实时数据清洗与转换</div>
          </div>
          {nodeCount > 0 ? (
            <span className={styles.statusConfigured}><Icons.Check size={10} /> 已启用 {nodeCount} 个节点</span>
          ) : (
            <span className={styles.statusUnconfigured}>未启用</span>
          )}
        </div>
        <button className={styles.entryNavBtn} onClick={() => setShowWorkspace(true)} title="配置工作流">
          <Icons.ChevronRight size={20} />
        </button>
      </div>

      {showWorkspace && (
        <OrchestrationWorkspace
          config={config}
          onChange={onChange}
          onSave={onSave}
          onClose={() => setShowWorkspace(false)}
          forwardConfig={forwardConfig}
          customParams={customParams}
          runParams={runParams}
        />
      )}
    </>
  );
}
