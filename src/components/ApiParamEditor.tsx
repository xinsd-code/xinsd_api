'use client';

import { KeyValuePair } from '@/lib/types';

interface ApiParamEditorProps {
  items: KeyValuePair[];
  onChange: (items: KeyValuePair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

const PARAM_TYPES = ['string', 'integer', 'boolean', 'number', 'array'] as const;

export default function ApiParamEditor({
  items,
  onChange,
  keyPlaceholder = 'Parameter Name',
  valuePlaceholder = 'Describe or define default value',
}: ApiParamEditorProps) {
  const handleAdd = () => {
    onChange([...items, { key: '', value: '', type: 'string' }]);
  };

  const handleRemove = (index: number) => {
    const newItems = items.filter((_, i) => i !== index);
    onChange(newItems);
  };

  const handleChange = (index: number, field: keyof KeyValuePair, val: string) => {
    const newItems = items.map((item, i) =>
      i === index ? { ...item, [field]: val } : item
    );
    onChange(newItems);
  };

  return (
    <div>
      {items.map((item, index) => (
        <div key={index} className="kv-row">
          <input
            className="form-input form-input-mono"
            placeholder={keyPlaceholder}
            value={item.key}
            onChange={(e) => handleChange(index, 'key', e.target.value)}
          />
          <select
            className="form-select form-input-mono"
            style={{ width: '120px', flexShrink: 0 }}
            value={item.type || 'string'}
            onChange={(e) => handleChange(index, 'type', e.target.value)}
          >
            {PARAM_TYPES.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <input
            className="form-input form-input-mono"
            placeholder={valuePlaceholder}
            value={item.value}
            onChange={(e) => handleChange(index, 'value', e.target.value)}
          />
          <button
            className="btn btn-icon btn-ghost"
            onClick={() => handleRemove(index)}
            title="删除"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="kv-add-btn" onClick={handleAdd}>
        + 添加
      </button>
    </div>
  );
}
