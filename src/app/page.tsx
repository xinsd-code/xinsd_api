'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { MockAPI } from '@/lib/types';
import MockEditor from '@/components/MockEditor';
import GroupVarsModal from '@/components/GroupVarsModal';
import { Icons } from '@/components/Icons';

export default function Home() {
  const [mocks, setMocks] = useState<MockAPI[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingMock, setEditingMock] = useState<MockAPI | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string>('ALL');
  const [groupFilter, setGroupFilter] = useState<string>('ALL');
  const [showGroupVars, setShowGroupVars] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchMocks = useCallback(async () => {
    try {
      const res = await fetch('/api/mocks');
      const data = await res.json();
      setMocks(data);
    } catch (error) {
      console.error('Failed to fetch mocks:', error);
      showToast('获取接口列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchMocks();
  }, [fetchMocks]);

  const handleCreate = () => {
    setEditingMock(null);
    setShowEditor(true);
  };

  const handleEdit = (mock: MockAPI) => {
    setEditingMock(mock);
    setShowEditor(true);
  };

  const handleSave = async (data: Partial<MockAPI>) => {
    try {
      if (editingMock) {
        const res = await fetch(`/api/mocks/${editingMock.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Update failed');
        showToast('接口更新成功');
      } else {
        const res = await fetch('/api/mocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('Create failed');
        showToast('接口创建成功');
      }
      setShowEditor(false);
      setEditingMock(null);
      fetchMocks();
    } catch (error) {
      console.error('Save failed:', error);
      showToast('保存失败', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个接口吗？')) return;
    try {
      const res = await fetch(`/api/mocks/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      showToast('接口已删除');
      fetchMocks();
    } catch (error) {
      console.error('Delete failed:', error);
      showToast('删除失败', 'error');
    }
  };

  const handleToggle = async (id: string) => {
    try {
      const res = await fetch('/api/mocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id }),
      });
      if (!res.ok) throw new Error('Toggle failed');
      fetchMocks();
    } catch (error) {
      console.error('Toggle failed:', error);
      showToast('切换状态失败', 'error');
    }
  };

  const filteredMocks = useMemo(() => {
    return mocks.filter((mock) => {
      const matchesSearch =
        !searchQuery ||
        mock.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mock.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mock.description.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesMethod = methodFilter === 'ALL' || mock.method === methodFilter;
      const matchesGroup = groupFilter === 'ALL' || mock.apiGroup === groupFilter || (!mock.apiGroup && groupFilter === '未分组');

      return matchesSearch && matchesMethod && matchesGroup;
    });
  }, [mocks, searchQuery, methodFilter, groupFilter]);

  const allGroups = useMemo(() => {
    return Array.from(new Set(mocks.map(m => m.apiGroup || '未分组'))).sort();
  }, [mocks]);

  const stats = useMemo(() => ({
    total: mocks.length,
    enabled: mocks.filter((m) => m.enabled).length,
    stream: mocks.filter((m) => m.isStream).length,
    methods: [...new Set(mocks.map((m) => m.method))].length,
  }), [mocks]);

  const hasRestful = (path: string) => path.includes(':');

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '16px' }}>
        <div style={{ width: '40px', height: '40px', border: '3px solid var(--color-bg-subtle)', borderTopColor: 'var(--color-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
        <style dangerouslySetInnerHTML={{ __html: `@keyframes spin { to { transform: rotate(360deg); } }` }} />
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-muted)' }}>正在加载工作室...</p>
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: '32px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 800, marginBottom: '8px' }}>Mock 接口集</h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '15px' }}>精准管理和模拟您的 API 端点。</p>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-card-label">接口总数</div>
          <div className="stat-card-value">{stats.total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">已启用</div>
          <div className="stat-card-value" style={{ color: 'var(--color-accent)' }}>{stats.enabled}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">流式响应</div>
          <div className="stat-card-value">{stats.stream}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">请求方法</div>
          <div className="stat-card-value">{stats.methods}</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-bar">
            <Icons.Search className="search-bar-icon" size={16} />
            <input
              className="search-bar-input"
              placeholder="搜索名称或路径..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <div style={{ display: 'flex', gap: '8px' }}>
            {['ALL', 'GET', 'POST', 'PUT', 'DELETE'].map((m) => (
              <button
                key={m}
                className={`filter-chip ${methodFilter === m ? 'active' : ''}`}
                onClick={() => setMethodFilter(m)}
              >
                {m === 'ALL' ? '全部类型' : m}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar-right">
          <select
            className="form-select"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            style={{ width: 'auto', height: '40px', borderRadius: 'var(--radius-full)', padding: '0 32px 0 16px' }}
          >
            <option value="ALL">所有分组</option>
            {allGroups.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          {groupFilter !== 'ALL' && (
            <button 
              className="btn btn-secondary btn-icon" 
              onClick={() => setShowGroupVars(true)}
              title="分组设置"
            >
              <Icons.Settings size={18} />
            </button>
          )}
          <button className="btn btn-primary" onClick={handleCreate}>
            <Icons.Plus size={18} />
            新建接口
          </button>
        </div>
      </div>

      {filteredMocks.length === 0 ? (
        <div className="card" style={{ padding: '80px 40px', textAlign: 'center' }}>
          <div style={{ 
            width: '64px', 
            height: '64px', 
            background: 'var(--color-bg-subtle)', 
            borderRadius: 'var(--radius-xl)', 
            display: 'inline-flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            marginBottom: '24px',
            color: 'var(--color-text-muted)'
          }}>
            <Icons.Box size={32} />
          </div>
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>
            {mocks.length === 0 ? '暂无接口' : '未找到匹配结果'}
          </h3>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '14px', marginBottom: '24px' }}>
            {mocks.length === 0 
              ? '创建您的第一个 Mock 接口以开始模拟 API 数据。' 
              : '尝试调整搜索条件或筛选器以查找内容。'}
          </p>
          {mocks.length === 0 && (
            <button className="btn btn-primary" onClick={handleCreate}>
              <Icons.Plus size={18} />
              创建第一个接口
            </button>
          )}
        </div>
      ) : (
        <div className="card stagger-in">
          {filteredMocks.map((mock) => (
            <div key={mock.id} className="mock-item">
              <button
                className={`status-toggle ${mock.enabled ? 'active' : ''}`}
                onClick={() => handleToggle(mock.id)}
                title={mock.enabled ? '点击禁用' : '点击启用'}
              />
              <div className={`method-badge method-${mock.method.toLowerCase()}`}>
                {mock.method}
              </div>
              <div className="mock-item-info">
                <div className="mock-item-name">{mock.name}</div>
                <div className="mock-item-path">
                  <span style={{ color: 'var(--color-primary-accent)' }}>/mock</span>
                  <span>{mock.path}</span>
                </div>
                <div className="mock-item-tags">
                  {mock.apiGroup && mock.apiGroup !== '未分组' && (
                    <span className="tag tag-default">
                      <Icons.Layers size={10} style={{ marginRight: '4px' }} />
                      {mock.apiGroup}
                    </span>
                  )}
                  {hasRestful(mock.path) && (
                    <span className="tag" style={{ background: '#f0fdf4', color: '#15803d' }}>
                      RESTFUL
                    </span>
                  )}
                  {mock.isStream && (
                    <span className="tag" style={{ background: '#fef2f2', color: '#dc2626' }}>
                      流式响应
                    </span>
                  )}
                  {mock.responseDelay > 0 && (
                    <span className="tag" style={{ background: 'var(--color-bg-hover)', color: 'var(--color-text-secondary)' }}>
                      {mock.responseDelay}ms 延迟
                    </span>
                  )}
                </div>
              </div>
              <div className="mock-item-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => handleEdit(mock)}>
                  <Icons.Edit size={14} />
                  编辑
                </button>
                <button
                  className="btn btn-danger-ghost btn-icon btn-sm"
                  onClick={() => handleDelete(mock.id)}
                >
                  <Icons.Trash size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <MockEditor
          key={editingMock?.id || 'new'}
          mock={editingMock}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false);
            setEditingMock(null);
          }}
        />
      )}

      {showGroupVars && groupFilter !== 'ALL' && (
        <GroupVarsModal
          groupName={groupFilter}
          onClose={() => setShowGroupVars(false)}
          onSaveToast={showToast}
        />
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.type === 'success' ? <Icons.Check size={18} /> : <Icons.Info size={18} />}
          {toast.message}
        </div>
      )}
    </>
  );
}
