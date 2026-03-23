'use client';

import { useRef, useEffect } from 'react';
import { Icons } from './Icons';

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: number;
  textareaName?: string;
  textareaLabel?: string;
}

export default function JsonEditor({
  value,
  onChange,
  height = 200,
  textareaName = 'json-editor',
  textareaLabel = 'JSON 编辑器',
}: JsonEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = `${height}px`;
    }
  }, [height]);

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, 2));
    } catch {
      // 格式不正确，跳过格式化
    }
  };

  const handleMinify = () => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed));
    } catch {
      // 格式不正确，跳过压缩
    }
  };

  const isValidJson = (() => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <div className="card" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'white' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', background: 'var(--color-bg-subtle)', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isValidJson ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-success)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
              <Icons.Check size={12} />
              JSON 格式正确
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
              <Icons.Info size={12} />
              JSON 格式有误
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" style={{ height: 24, fontSize: 11, fontWeight: 700, padding: '0 8px' }} onClick={handleFormat}>格式化</button>
          <button type="button" className="btn btn-ghost btn-sm" style={{ height: 24, fontSize: 11, fontWeight: 700, padding: '0 8px' }} onClick={handleMinify}>压缩</button>
        </div>
      </div>
      <div style={{ padding: 0 }}>
        <textarea
          ref={textareaRef}
          name={textareaName}
          aria-label={textareaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            minHeight: height,
            padding: 16,
            border: 'none',
            outline: 'none',
            resize: 'vertical',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--color-text)',
            background: 'transparent',
            tabSize: 2,
            display: 'block'
          }}
          spellCheck={false}
          placeholder='{ "data": "在此处输入 JSON" }'
        />
      </div>
    </div>
  );
}
