'use client';

import { useRef, useEffect } from 'react';

interface JsonEditorProps {
  value: string;
  onChange: (value: string) => void;
  height?: number;
}

export default function JsonEditor({ value, onChange, height = 200 }: JsonEditorProps) {
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
      // invalid JSON, don't format
    }
  };

  const handleMinify = () => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed));
    } catch {
      // invalid JSON, don't format
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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: isValidJson ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 500 }}>
          {isValidJson ? '✓ 有效 JSON' : '✕ 无效 JSON'}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={handleFormat}>格式化</button>
          <button className="btn btn-ghost btn-sm" onClick={handleMinify}>压缩</button>
        </div>
      </div>
      <div className="editor-container">
        <textarea
          ref={textareaRef}
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
            background: '#fafbfc',
            tabSize: 2,
          }}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
