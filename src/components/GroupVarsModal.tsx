import { useState, useEffect } from 'react';
import { KeyValuePair } from '@/lib/types';
import KeyValueEditor from './KeyValueEditor';

interface Props {
  groupName: string;
  onClose: () => void;
  onSaveToast: (msg: string, type?: 'success' | 'error') => void;
}

export default function GroupVarsModal({ groupName, onClose, onSaveToast }: Props) {
  const [vars, setVars] = useState<KeyValuePair[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/groups/${encodeURIComponent(groupName)}/variables`)
      .then(r => r.json())
      .then(data => {
        setVars(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => {
        onSaveToast('无法加载环境变量', 'error');
        setLoading(false);
      });
  }, [groupName, onSaveToast]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupName)}/variables`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars.filter(v => v.key)),
      });
      if (!res.ok) throw new Error();
      onSaveToast('环境变量保存成功');
      onClose();
    } catch {
      onSaveToast('保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h3 className="modal-title">环境变量 - {groupName}</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} style={{ padding: 4, width: 28, height: 28 }}>✕</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20 }}>
            定义变量后，可在 API URL、Params、Headers、Body 以及 Mock 返回包中，使用 <code style={{fontFamily: 'var(--font-mono)', background: 'var(--color-bg-hover)', padding: '2px 4px', borderRadius: 4}}>{'{{VAR_NAME}}'}</code> 引用。
          </p>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--color-text-muted)' }}>加载中...</div>
          ) : (
            <KeyValueEditor
              items={vars}
              onChange={setVars}
              keyPlaceholder="变量名 (如 HOST)"
              valuePlaceholder="变量值 (如 https://api.example.com)"
            />
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存修改'}
          </button>
        </div>
      </div>
    </div>
  );
}
