'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import {
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
import styles from './orchestration.module.css';

const NODE_TYPE_META: Record<OrchestrationNodeType, { icon: string; label: string; color: string }> = {
  filter: { icon: '🔍', label: '数据筛选', color: 'filter' },
  map: { icon: '🔄', label: '字段映射', color: 'map' },
  compute: { icon: '⚡', label: '字段新增', color: 'compute' },
  sort: { icon: '📊', label: '排序限制', color: 'sort' },
};

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

function isObjectLike(value: any): value is Record<string, any> {
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
function extractFieldPaths(obj: any, prefix = ''): string[] {
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
function extractArrayFieldOptions(obj: any): ArrayFieldOption[] {
  const optionsMap = new Map<string, Set<string>>();

  const collectArrayFields = (arr: any[], arrayPath: string) => {
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

  const visit = (value: any, currentPath: string) => {
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
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputEl) {
      inputEl.indeterminate = indeterminate;
    }
  }, [inputEl, indeterminate]);

  return (
    <input
      ref={setInputEl}
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
    for (const child of node.children) {
      paths.push(...getNodeSelectablePaths(child));
    }
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
              <label className={styles.fieldCheckboxItem} style={{ paddingLeft: 8 + level * 14 }}>
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
    const m = [...config.mappings]; m[i] = { ...m[i], [field]: val };
    onChange({ ...config, mappings: m });
  };
  const removeMapping = (i: number) => onChange({ ...config, mappings: config.mappings.filter((_, idx) => idx !== i) });

  return (
    <div className={styles.configSection}>
      <div className={styles.configSectionTitle}>映射规则</div>
      {config.mappings.map((m, i) => (
        <div key={i} className={styles.configRow}>
          <select value={m.from} onChange={(e) => updateMapping(i, 'from', e.target.value)}
            className="form-select" style={{ flex: 1, fontSize: 13 }}>
            <option value="">选择原字段</option>
            {availableFields.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12, flexShrink: 0 }}>→</span>
          <input type="text" value={m.to} onChange={(e) => updateMapping(i, 'to', e.target.value)}
            className="form-input" placeholder="新字段名" style={{ flex: 1, fontSize: 13 }} />
          <button className={styles.configRemoveBtn} onClick={() => removeMapping(i)} title="删除">✕</button>
        </div>
      ))}
      <button className={styles.configAddBtn} onClick={addMapping}>+ 添加映射</button>
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

  return (
    <div className={styles.configSection}>
      <div className={styles.configSectionTitle}>计算规则</div>
      {config.computations.map((c, i) => (
        <div key={i} className={styles.computeBlock}>
          <div className={styles.configRow}>
            <input type="text" value={c.field} onChange={(e) => updateComp(i, 'field', e.target.value)}
              className="form-input" placeholder="新字段名" style={{ flex: 1, fontSize: 13 }} />
            <button className={styles.configRemoveBtn} onClick={() => removeComp(i)} title="删除">✕</button>
          </div>
          <div className={styles.configRow} style={{ marginTop: 6 }}>
            <select value={c.sourceField || ''} onChange={(e) => updateComp(i, 'sourceField', e.target.value)}
              className="form-select" style={{ flex: 1, fontSize: 13 }}>
              <option value="">复制来源字段（可选）</option>
              {availableFields.map(f => <option key={f} value={f}>{f}</option>)}
              {customParams.map(p => <option key={`param-direct:${p.key}`} value={p.key}>📌 入参直取: {p.key}</option>)}
              {customParams.map(p => <option key={`param:${p.key}`} value={`$param.${p.key}`}>📌 入参: {p.key}</option>)}
            </select>
          </div>
          <div className={styles.configRow} style={{ marginTop: 6 }}>
            <input type="text" value={c.expression} onChange={(e) => updateComp(i, 'expression', e.target.value)}
              className="form-input" placeholder="如 {{bbb}} * 0.1 或 {{$param.rate}}" style={{ flex: 1, fontSize: 13 }} />
          </div>
        </div>
      ))}
      <button className={styles.configAddBtn} onClick={addComp}>+ 添加字段</button>
      <div className={styles.computeHint}>支持模板: {'{{字段}}'}、{'{{入参key}}'}、{'{{$param.key}}'}</div>
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

  const handleArrayPathChange = (value: string) => {
    const normalizedNextPath = normalizePath(value);
    const nextArray = arrayFieldOptions.find(option => normalizePath(option.arrayPath) === normalizedNextPath);
    const nextSortField = nextArray && config.sortField && !nextArray.itemFields.includes(config.sortField)
      ? ''
      : config.sortField;
    onChange({ ...config, arrayPath: value, sortField: nextSortField });
  };

  return (
    <div>
      <div className={styles.configSection}>
        <div className={styles.configSectionTitle}>数组路径</div>
        <input
          type="text"
          list="array-path-options"
          value={config.arrayPath}
          onChange={(e) => handleArrayPathChange(e.target.value)}
          className="form-input"
          placeholder="留空表示根数组，或如 data.items"
          style={{ fontSize: 13 }}
        />
        <datalist id="array-path-options">
          <option value="">(根数组)</option>
          {arrayFieldOptions.map(option => (
            <option key={option.arrayPath || '__root'} value={option.arrayPath}>
              {option.arrayPath || '(根数组)'}
            </option>
          ))}
        </datalist>
      </div>
      <div className={styles.configSection}>
        <div className={styles.configSectionTitle}>排序字段</div>
        <select value={config.sortField} onChange={(e) => onChange({ ...config, sortField: e.target.value })}
          className="form-select" style={{ fontSize: 13 }}>
          <option value="">选择排序字段</option>
          {sortFields.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        {selectedArray && (
          <div className={styles.sortHint}>当前针对数组: {selectedArray.arrayPath || '(根数组)'}</div>
        )}
      </div>
      <div className={styles.configSection}>
        <div className={styles.configSectionTitle}>排序方向</div>
        <select value={config.order} onChange={(e) => onChange({ ...config, order: e.target.value as 'asc' | 'desc' })}
          className="form-select" style={{ fontSize: 13 }}>
          <option value="asc">升序 (ASC)</option>
          <option value="desc">降序 (DESC)</option>
        </select>
      </div>
      <div className={styles.configSection}>
        <div className={styles.configSectionTitle}>结果限制 (可选)</div>
        <input type="number" value={config.limit || ''} onChange={(e) => onChange({ ...config, limit: e.target.value ? parseInt(e.target.value) : undefined })}
          className="form-input" placeholder="留空表示不限制" style={{ fontSize: 13 }} min={1} />
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
            <span className={styles.nodeSummaryValue}>{cfg.fields.length > 0 ? cfg.fields.join(', ') : '未配置'}</span>
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
              <span className={styles.nodeSummaryKey}>→</span>
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
              <span className={styles.nodeSummaryValue}>{c.sourceField || c.expression || '?'}</span>
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
  targetType: 'mock' | 'api-client';
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
  onSave?: () => Promise<void> | void;
  onClose: () => void;
  forwardConfig: ForwardConfigRef;
  customParams: CustomParamDef[];
  runParams: Record<string, string>;
}) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [inputData, setInputData] = useState<any>(null);
  const [inputLoading, setInputLoading] = useState(false);
  const [previewParams, setPreviewParams] = useState<Record<string, string>>(
    () => buildPreviewParams(customParams, runParams)
  );
  const [debugResult, setDebugResult] = useState<any>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [debugMode, setDebugMode] = useState<'node' | 'pipeline' | null>(null);
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);

  const nodes = config?.nodes || [];
  const sortedNodes = [...nodes].sort((a, b) => a.order - b.order);
  const editingNode = editingNodeId ? nodes.find(n => n.id === editingNodeId) : null;
  const configJsonPreview = useMemo(() => JSON.stringify({ nodes: sortedNodes }, null, 2), [sortedNodes]);
  const originalInputFields = useMemo(
    () => (inputData ? extractFieldPaths(inputData) : []),
    [inputData]
  );
  const computedNodeOutputs = useMemo(() => {
    if (!inputData || sortedNodes.length === 0) return {} as Record<string, any>;

    const outputs: Record<string, any> = {};
    let current = inputData;

    for (const node of sortedNodes) {
      try {
        current = applyNode(current, node, previewParams);
      } catch {
        // Keep current output when this node has invalid config while editing.
      }
      outputs[node.id] = current;
    }

    return outputs;
  }, [inputData, sortedNodes, previewParams]);

  // 获取输入数据：通过当前API转发配置执行请求
  const fetchInputData = useCallback(async () => {
    if (!forwardConfig.targetId) return;
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
        setInputData(result.data || result);
      }
    } catch (err) {
      console.error('Failed to fetch input data', err);
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

  const getNodeInputData = useCallback((nodeId: string): any => {
    const idx = sortedNodes.findIndex(n => n.id === nodeId);
    if (idx <= 0) {
      return inputData;
    }
    const prevNodeId = sortedNodes[idx - 1].id;
    return computedNodeOutputs[prevNodeId] ?? inputData;
  }, [sortedNodes, inputData, computedNodeOutputs]);

  // 计算每个节点的可用字段（基于前一个节点输出或原始输入）
  const getAvailableFields = useCallback((nodeId: string): string[] => {
    const nodeInputData = getNodeInputData(nodeId);
    if (!nodeInputData) return [];
    return extractFieldPaths(nodeInputData);
  }, [getNodeInputData]);

  const getArrayFieldOptions = useCallback((nodeId: string): ArrayFieldOption[] => {
    const nodeInputData = getNodeInputData(nodeId);
    if (!nodeInputData) return [];
    return extractArrayFieldOptions(nodeInputData);
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
  };

  const removeNode = (id: string) => {
    const filtered = nodes.filter(n => n.id !== id);
    updateNodes(filtered.map((n, i) => ({ ...n, order: i })));
    if (editingNodeId === id) setEditingNodeId(null);
  };

  const updateNodeConfig = (id: string, newConfig: any) => {
    updateNodes(nodes.map(n => n.id === id ? { ...n, config: newConfig } : n));
  };

  const updateNodeLabel = (id: string, label: string) => {
    updateNodes(nodes.map(n => n.id === id ? { ...n, label } : n));
  };

  // 调试到某个节点
  const debugNode = async (nodeId: string) => {
    if (!inputData) { await fetchInputData(); return; }
    setDebugLoading(true);
    setDebugResult(null);
    setDebugMode('node');
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
    } catch (err: any) {
      setDebugResult({ error: err.message });
    } finally {
      setDebugLoading(false);
    }
  };

  // 全量试运行
  const runFullPipeline = async () => {
    if (!inputData) { await fetchInputData(); return; }
    setDebugLoading(true);
    setDebugResult(null);
    setDebugMode('pipeline');
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
    } catch (err: any) {
      setDebugResult({ error: err.message });
    } finally {
      setDebugLoading(false);
    }
  };

  const saveWorkflowConfig = async () => {
    if (!onSave) return;
    setSaveLoading(true);
    try {
      await onSave();
    } finally {
      setSaveLoading(false);
    }
  };

  // 拖拽排序
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
  const handleDragEnd = () => { setDragNodeId(null); };

  return (
    <div className={styles.workspaceOverlay}>
      <div className={styles.workspace}>
        {/* Top Bar */}
        <div className={styles.workspaceTopBar}>
          <div className={styles.topBarLeft}>
            <button className={styles.backBtn} onClick={onClose}>
              ← 返回配置
            </button>
            <div className={styles.topBarTitle}>
              <span className={styles.topBarIcon}>⚙</span>
              高级编排工作流
            </div>
          </div>
          <div className={styles.topBarRight}>
            {customParams.length > 0 && (
              <div className={styles.paramsBadge}>
                📌 可用入参: {customParams.map(p => p.key).join(', ')}
              </div>
            )}
            <button className={styles.refreshBtn} onClick={fetchInputData} disabled={inputLoading}>
              {inputLoading ? '⏳ 获取中...' : '🔄 刷新数据'}
            </button>
            <button
              className={`${styles.runBtn} ${debugLoading ? styles.running : ''}`}
              onClick={runFullPipeline}
              disabled={debugLoading || nodes.length === 0}
            >
              {debugLoading ? '⏳ 执行中...' : '➡️ 编排试运行'}
            </button>
            <button
              className={styles.saveBtn}
              onClick={saveWorkflowConfig}
              disabled={saveLoading}
            >
              {saveLoading ? '⏳ 保存中...' : '💾 保存编排'}
            </button>
          </div>
        </div>

        <div className={styles.workspaceBody}>
          {/* Left: Canvas */}
          <div className={styles.canvasArea}>
            {/* Node Toolbar */}
            <div className={styles.canvasToolbar}>
              <span className={styles.toolbarLabel}>添加节点:</span>
              {(Object.entries(NODE_TYPE_META) as [OrchestrationNodeType, typeof NODE_TYPE_META[OrchestrationNodeType]][]).map(([type, meta]) => (
                <button key={type} className={styles.addNodeBtn} onClick={() => addNode(type)}>
                  <span className={styles.nodeTypeIcon}>{meta.icon}</span>
                  {meta.label}
                </button>
              ))}
            </div>

            {/* Pipeline Canvas */}
            {nodes.length === 0 ? (
              <div className={styles.pipelineEmpty}>
                <div className={styles.emptyIcon}>🔗</div>
                <div>点击上方按钮添加编排节点，构建数据处理管线</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  支持: 数据筛选 → 字段映射 → 字段新增 → 排序限制
                </div>
              </div>
            ) : (
              <>
                <div className={styles.pipeline}>
                  <div className={`${styles.endpointBox} ${styles.input}`}>
                    <span className={styles.endpointIcon}>📥</span>
                    <span className={styles.endpointLabel}>输入</span>
                  </div>
                  {sortedNodes.map((node, index) => (
                    <div key={node.id} style={{ display: 'flex', alignItems: 'flex-start' }}>
                      <div className={styles.connector}><div className={styles.connectorLine} /></div>
                      <div
                        className={`${styles.nodeCard} ${editingNodeId === node.id ? styles.active : ''} ${dragNodeId === node.id ? styles.dragging : ''}`}
                        draggable
                        onDragStart={(e) => handleDragStart(e, node.id)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, node.id)}
                        onDragEnd={handleDragEnd}
                        onClick={() => setEditingNodeId(editingNodeId === node.id ? null : node.id)}
                      >
                        <span className={styles.nodeOrderBadge}>{index + 1}</span>
                        <div className={styles.nodeCardHeader}>
                          <span className={`${styles.nodeTypeTag} ${styles[NODE_TYPE_META[node.type].color]}`}>
                            {NODE_TYPE_META[node.type].icon} {NODE_TYPE_META[node.type].label}
                          </span>
                          <div className={styles.nodeActions}>
                            <button className={`${styles.nodeActionBtn} ${styles.debug}`}
                              onClick={(e) => { e.stopPropagation(); debugNode(node.id); }} title="调试到此节点">🐛</button>
                            <button className={`${styles.nodeActionBtn} ${styles.delete}`}
                              onClick={(e) => { e.stopPropagation(); removeNode(node.id); }} title="删除节点">🗑</button>
                          </div>
                        </div>
                        <div className={styles.nodeCardBody}><NodeSummary node={node} /></div>
                      </div>
                    </div>
                  ))}
                  <div className={styles.connector}><div className={styles.connectorLine} /></div>
                  <div className={`${styles.endpointBox} ${styles.output}`}>
                    <span className={styles.endpointIcon}>📤</span>
                    <span className={styles.endpointLabel}>输出</span>
                  </div>
                </div>
                <div className={styles.dragHint}>💡 拖拽节点卡片可调整执行顺序 · 点击节点可在右侧编辑</div>
              </>
            )}

            {/* Input/Output Data Preview */}
            <div className={styles.dataPreviewArea}>
              <div className={styles.dataPreviewPane}>
                <div className={styles.dataPreviewHeader}>
                  📥 输入数据
                  <button className={styles.miniBtn} onClick={fetchInputData} disabled={inputLoading}>
                    {inputLoading ? '⏳' : '🔄'}
                  </button>
                </div>
                {customParams.length > 0 && (
                  <div className={styles.previewParamsPanel}>
                    <div className={styles.previewParamsHint}>先填写真实入参，再点击刷新获取真实返回数据</div>
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
                            style={{ fontSize: 12, height: 30 }}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <pre className={styles.dataPreviewPre}>
                  {inputData ? JSON.stringify(inputData, null, 2) : (inputLoading ? '获取中...' : '暂无数据，点击刷新获取')}
                </pre>
              </div>
              <div className={styles.dataPreviewPane}>
                <div className={styles.dataPreviewHeader}>
                  🧾 工作流配置 JSON
                </div>
                <pre className={styles.dataPreviewPre}>{configJsonPreview}</pre>
              </div>
              {debugResult && (
                <div className={styles.dataPreviewPane}>
                  <div className={styles.dataPreviewHeader}>
                    {debugResult.error
                      ? '❌ 执行错误'
                      : '📤 编排输出'}
                    <button className={styles.miniBtn} onClick={() => setDebugResult(null)}>✕</button>
                  </div>
                  <pre className={styles.dataPreviewPre}>
                    {JSON.stringify(debugResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* Right: Node Properties Panel */}
          {editingNode && (
            <div className={styles.rightPanel}>
              <div className={styles.configHeader}>
                <div className={styles.configTitle}>
                  <span className={`${styles.nodeTypeTag} ${styles[NODE_TYPE_META[editingNode.type].color]}`}>
                    {NODE_TYPE_META[editingNode.type].icon} {NODE_TYPE_META[editingNode.type].label}
                  </span>
                  节点配置
                </div>
                <button className={styles.configCloseBtn} onClick={() => setEditingNodeId(null)}>✕</button>
              </div>
              <div className={styles.configBody}>
                <div className={styles.configSection}>
                  <div className={styles.configSectionTitle}>节点名称</div>
                  <input type="text" value={editingNode.label || ''} onChange={(e) => updateNodeLabel(editingNode.id, e.target.value)}
                    className="form-input" placeholder="自定义节点名称" style={{ fontSize: 13 }} />
                </div>
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
              <div className={styles.configFooter}>
                <button className="btn btn-secondary btn-sm" onClick={() => debugNode(editingNode.id)} disabled={debugLoading}>
                  🐛 调试此节点
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setEditingNodeId(null)}>完成</button>
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
  onSave?: () => Promise<void> | void;
  forwardConfig: ForwardConfigRef;
  customParams: CustomParamDef[];
  runParams: Record<string, string>;
}) {
  const [showWorkspace, setShowWorkspace] = useState(false);
  const nodeCount = config?.nodes?.length || 0;

  return (
    <>
      {/* Toggle Entry Row */}
      <div className={styles.orchestrationEntry}>
        <div className={styles.entryLeft}>
          <span className={styles.entryIcon}>⚙</span>
          <div className={styles.entryInfo}>
            <div className={styles.entryTitle}>高级编排</div>
            <div className={styles.entryDesc}>对API返回结果进行JSON数据编排处理</div>
          </div>
          {nodeCount > 0 ? (
            <span className={styles.statusConfigured}>✓ 已编排</span>
          ) : (
            <span className={styles.statusUnconfigured}>未编排</span>
          )}
        </div>
        <button className={styles.entryNavBtn} onClick={() => setShowWorkspace(true)} title="打开编排工作流">
          ›
        </button>
      </div>

      {/* Full-screen Workspace */}
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
