'use client';

import { KeyValuePair } from '@/lib/types';
import { Icons } from './Icons';

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
  keyPlaceholder = '参数名 (Key)',
  valuePlaceholder = '默认值或描述说明',
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item, index) => (
        <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="form-input"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 13, height: 36, flex: 1 }}
            placeholder={keyPlaceholder}
            value={item.key}
            onChange={(e) => handleChange(index, 'key', e.target.value)}
          />
          <select
            className="form-select"
            style={{ width: '110px', flexShrink: 0, height: '36px', fontSize: '12px', fontWeight: 700, padding: '0 24px 0 8px' }}
            value={item.type || 'string'}
            onChange={(e) => handleChange(index, 'type', e.target.value)}
          >
            {PARAM_TYPES.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <input
            className="form-input"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 13, height: 36, flex: 1.5 }}
            placeholder={valuePlaceholder}
            value={item.value}
            onChange={(e) => handleChange(index, 'value', e.target.value)}
          />
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => handleRemove(index)}
            style={{ color: 'var(--color-danger)', flexShrink: 0 }}
            title="删除"
          >
            <Icons.Trash size={14} />
          </button>
        </div>
      ))}
      <button 
        className="kv-add-btn" 
        onClick={handleAdd}
        style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          gap: 8, 
          height: 36, 
          marginTop: 4, 
          fontSize: 13, 
          fontWeight: 700, 
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-bg-subtle)',
          color: 'var(--color-text-secondary)',
          cursor: 'pointer',
          width: '100%',
          transition: 'all var(--transition-fast)'
        }}
      >
        <Icons.Plus size={14} />
        添加参数项
      </button>
    </div>
  );
}
