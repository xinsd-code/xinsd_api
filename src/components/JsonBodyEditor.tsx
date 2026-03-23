'use client';

import { useMemo, useState } from 'react';
import JsonEditor from './JsonEditor';
import { Icons } from './Icons';
import {
  JsonBodyField,
  JsonBodyFieldType,
  buildJsonBodyFromFields,
  detectJsonBodyFieldType,
  flattenJsonBody,
  parseJsonBody,
} from '@/lib/json-body';

interface JsonBodyEditorProps {
  value: string;
  onChange: (value: string) => void;
  mode?: 'design' | 'run';
  title?: string;
  description?: string;
  hint?: string;
  emptyHint?: string;
  height?: number;
}

const FIELD_TYPES: JsonBodyFieldType[] = ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null'];

function createEmptyField(): JsonBodyField {
  return {
    path: '',
    type: 'string',
    value: '',
  };
}

export default function JsonBodyEditor({
  value,
  onChange,
  mode = 'design',
  title = 'JSON Body',
  description = '支持表单视图与原始 JSON 双向编辑。',
  hint,
  emptyHint = '当前还没有可编辑的字段，可以直接在原始 JSON 中粘贴请求体，或手动新增字段。',
  height = 280,
}: JsonBodyEditorProps) {
  const [activeView, setActiveView] = useState<'form' | 'raw'>('form');

  const parsedJson = useMemo(() => parseJsonBody(value), [value]);
  const fields = useMemo(
    () => (parsedJson.error || parsedJson.data === null ? [] : flattenJsonBody(parsedJson.data)),
    [parsedJson]
  );

  const applyFields = (nextFields: JsonBodyField[]) => {
    try {
      const nextBody = JSON.stringify(buildJsonBodyFromFields(nextFields), null, 2);
      onChange(nextBody);
    } catch {
      // 忽略字段构建中的临时无效输入，等待用户继续编辑
    }
  };

  const handleFieldChange = (index: number, patch: Partial<JsonBodyField>) => {
    const nextFields = fields.map((field, fieldIndex) =>
      fieldIndex === index ? { ...field, ...patch } : field
    );
    applyFields(nextFields);
  };

  const handleAddField = () => {
    const nextIndex = fields.length + 1;
    const nextField = createEmptyField();
    nextField.path = `field${nextIndex}`;
    applyFields([...fields, nextField]);
  };

  const handleRemoveField = (index: number) => {
    const nextFields = fields.filter((_, fieldIndex) => fieldIndex !== index);
    applyFields(nextFields);
  };

  const handleFormatFromRaw = () => {
    if (parsedJson.error || parsedJson.data === null) return;
    onChange(JSON.stringify(parsedJson.data, null, 2));
  };

  const fieldCountLabel = parsedJson.error ? '原始 JSON 待修复' : `${fields.length} 个字段`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>
      <div
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          background: 'linear-gradient(180deg, rgba(248,250,252,0.82), rgba(255,255,255,0.98))',
          padding: '14px 16px',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.Code size={16} />
            <strong style={{ fontSize: 14 }}>{title}</strong>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: parsedJson.error ? 'var(--color-danger)' : 'var(--color-success)',
                background: parsedJson.error ? 'var(--color-danger-soft)' : 'color-mix(in srgb, var(--color-success) 12%, white)',
                border: `1px solid ${parsedJson.error ? 'var(--color-danger)' : 'color-mix(in srgb, var(--color-success) 30%, var(--color-border))'}`,
                borderRadius: 999,
                padding: '3px 8px',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {fieldCountLabel}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-muted)' }}>{description}</p>
          {hint && <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>{hint}</div>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div className="tabs" style={{ margin: 0, height: 34, width: 196 }}>
            <button type="button" className={`tab ${activeView === 'form' ? 'active' : ''}`} onClick={() => setActiveView('form')}>
              表单视图
            </button>
            <button type="button" className={`tab ${activeView === 'raw' ? 'active' : ''}`} onClick={() => setActiveView('raw')}>
              原始 JSON
            </button>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleFormatFromRaw}>
            <Icons.Refresh size={14} />
            同步格式
          </button>
        </div>
      </div>

      {activeView === 'form' ? (
        <div
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            background: 'white',
            overflow: 'hidden',
            minHeight: height,
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(160px, 1.2fr) 120px minmax(180px, 1fr) 44px',
              gap: 10,
              padding: '12px 16px',
              borderBottom: '1px solid var(--color-border)',
              background: 'var(--color-bg-subtle)',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
            }}
          >
            <span>字段路径</span>
            <span>类型</span>
            <span>{mode === 'run' ? '当前值' : '默认值 / 匹配值'}</span>
            <span />
          </div>

          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {fields.length === 0 ? (
              <div
                style={{
                  border: '1px dashed var(--color-border)',
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--color-bg-subtle)',
                  padding: '28px 20px',
                  textAlign: 'center',
                  color: 'var(--color-text-muted)',
                  fontSize: 13,
                  lineHeight: 1.7,
                }}
              >
                {emptyHint}
              </div>
            ) : (
              fields.map((field, index) => {
                const isStructuredValue = field.type === 'object' || field.type === 'array';
                return (
                  <div
                    key={`${field.path}-${index}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(160px, 1.2fr) 120px minmax(180px, 1fr) 44px',
                      gap: 10,
                      alignItems: 'start',
                    }}
                  >
                    <input
                      className="form-input"
                      name={`json-body-path-${mode}-${index}`}
                      aria-label={`JSON 字段路径 ${index + 1}`}
                      value={field.path}
                      placeholder="如 user.id / items[0].sku"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 13, minHeight: 38 }}
                      onChange={(event) => handleFieldChange(index, { path: event.target.value })}
                    />
                    <select
                      className="form-select"
                      name={`json-body-type-${mode}-${index}`}
                      aria-label={`JSON 字段类型 ${index + 1}`}
                      value={field.type}
                      style={{ height: 38, fontSize: 12, fontWeight: 700 }}
                      onChange={(event) => {
                        const nextType = event.target.value as JsonBodyFieldType;
                        let nextValue = field.value;
                        if (nextType === 'object' && detectJsonBodyFieldType(field.value) !== 'object') nextValue = '{}';
                        if (nextType === 'array' && detectJsonBodyFieldType(field.value) !== 'array') nextValue = '[]';
                        if (nextType === 'null') nextValue = '';
                        handleFieldChange(index, { type: nextType, value: nextValue });
                      }}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                    {isStructuredValue ? (
                      <textarea
                        className="form-input"
                        name={`json-body-value-${mode}-${index}`}
                        aria-label={`JSON 字段值 ${index + 1}`}
                        value={field.value}
                        placeholder={field.type === 'object' ? '{\n  "nested": true\n}' : '[\n  "item-1"\n]'}
                        style={{
                          minHeight: 92,
                          resize: 'vertical',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 13,
                          lineHeight: 1.6,
                          paddingTop: 10,
                        }}
                        onChange={(event) => handleFieldChange(index, { value: event.target.value })}
                      />
                    ) : (
                      <input
                        className="form-input"
                        name={`json-body-value-${mode}-${index}`}
                        aria-label={`JSON 字段值 ${index + 1}`}
                        value={field.value}
                        placeholder={field.type === 'boolean' ? 'true / false' : '请输入字段值'}
                        style={{ fontFamily: 'var(--font-mono)', fontSize: 13, minHeight: 38 }}
                        onChange={(event) => handleFieldChange(index, { value: event.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      style={{ color: 'var(--color-danger)', marginTop: 2 }}
                      onClick={() => handleRemoveField(index)}
                      title="删除字段"
                    >
                      <Icons.Trash size={14} />
                    </button>
                  </div>
                );
              })
            )}

            <button
              type="button"
              className="btn btn-secondary"
              style={{ alignSelf: 'flex-start' }}
              onClick={handleAddField}
            >
              <Icons.Plus size={14} />
              新增字段
            </button>

            {mode === 'run' && (
              <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--color-text-muted)' }}>
                表单值会实时回写到下方实际发送的 JSON 内容，适合像 Postman / Apifox 那样边填边预览。
              </div>
            )}
          </div>
        </div>
      ) : (
        <JsonEditor
          value={value}
          onChange={onChange}
          height={height}
          textareaName={`json-body-editor-${mode}`}
          textareaLabel={`${title} 原始 JSON`}
        />
      )}
    </div>
  );
}
