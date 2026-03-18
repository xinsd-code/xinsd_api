import { useState, useEffect } from 'react';
import { KeyValuePair } from '@/lib/types';
import KeyValueEditor from './KeyValueEditor';
import { Icons } from './Icons';

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
        onSaveToast('无法加载变量', 'error');
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
      onSaveToast('变量保存成功');
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
          <div>
            <h3 className="modal-title">环境变量: {groupName}</h3>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>为此集合配置运行时的环境变量。</p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <Icons.X size={20} />
          </button>
        </div>
        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <div style={{ 
            padding: '16px', 
            background: 'var(--color-bg-subtle)', 
            borderRadius: 'var(--radius-lg)', 
            border: '1px solid var(--color-border)',
            marginBottom: 24,
            display: 'flex',
            gap: 12
          }}>
            <Icons.Info size={18} style={{ color: 'var(--color-primary-accent)', flexShrink: 0 }} />
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              定义的变量可以通过 
              <code style={{fontFamily: 'var(--font-mono)', background: 'white', padding: '2px 6px', borderRadius: 4, margin: '0 4px', border: '1px solid var(--color-border)', fontSize: 12}}>{'{{变量名}}'}</code> 语法在 URL、参数、Header 和请求体中引用。
            </p>
          </div>
          
          {loading ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--color-text-muted)', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
              <div style={{ width: 32, height: 32, border: '3px solid var(--color-bg-subtle)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
              <span style={{ fontSize: 13, fontWeight: 700 }}>正在加载环境配置...</span>
            </div>
          ) : (
            <div className="stagger-in">
              <KeyValueEditor
                items={vars}
                onChange={setVars}
                keyPlaceholder="键 (例如: API_URL)"
                valuePlaceholder="值 (例如: https://api.prd.com)"
              />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <div style={{ width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div> : <Icons.Check size={16} />}
            {saving ? '' : '保存修改'}
          </button>
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `@keyframes spin { to { transform: rotate(360deg); } }` }} />
    </div>
  );
}
