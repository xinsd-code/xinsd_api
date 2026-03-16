'use client';

import { StreamConfig } from '@/lib/types';

interface StreamConfigEditorProps {
  config: StreamConfig;
  onChange: (config: StreamConfig) => void;
}

export default function StreamConfigEditor({
  config,
  onChange,
}: StreamConfigEditorProps) {
  const handleChunkChange = (index: number, value: string) => {
    const newChunks = config.chunks.map((chunk, i) =>
      i === index ? value : chunk
    );
    onChange({ ...config, chunks: newChunks });
  };

  const handleAddChunk = () => {
    onChange({ ...config, chunks: [...config.chunks, ''] });
  };

  const handleRemoveChunk = (index: number) => {
    const newChunks = config.chunks.filter((_, i) => i !== index);
    onChange({ ...config, chunks: newChunks });
  };

  return (
    <div>
      <div className="form-group">
        <label className="form-label">Chunk 间隔时间 (ms)</label>
        <input
          type="number"
          className="form-input"
          value={config.chunkDelay}
          onChange={(e) =>
            onChange({ ...config, chunkDelay: parseInt(e.target.value) || 100 })
          }
          min={0}
          style={{ maxWidth: 200 }}
        />
      </div>

      <div className="form-group">
        <label className="form-label">数据块列表</label>
        {config.chunks.map((chunk, index) => (
          <div key={index} className="stream-chunk">
            <div className="stream-chunk-num">{index + 1}</div>
            <textarea
              className="form-textarea"
              value={chunk}
              onChange={(e) => handleChunkChange(index, e.target.value)}
              placeholder={`第 ${index + 1} 个数据块 (JSON 或纯文本)`}
            />
            <button
              className="btn btn-icon btn-ghost"
              onClick={() => handleRemoveChunk(index)}
              title="删除"
              style={{ marginTop: 8 }}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="kv-add-btn" onClick={handleAddChunk}>
          + 添加数据块
        </button>
      </div>
    </div>
  );
}
