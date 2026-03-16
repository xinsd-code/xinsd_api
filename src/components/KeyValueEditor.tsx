'use client';

import { KeyValuePair } from '@/lib/types';

interface KeyValueEditorProps {
  items: KeyValuePair[];
  onChange: (items: KeyValuePair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export default function KeyValueEditor({
  items,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
}: KeyValueEditorProps) {
  const handleAdd = () => {
    onChange([...items, { key: '', value: '' }]);
  };

  const handleRemove = (index: number) => {
    const newItems = items.filter((_, i) => i !== index);
    onChange(newItems);
  };

  const handleChange = (index: number, field: 'key' | 'value', val: string) => {
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
