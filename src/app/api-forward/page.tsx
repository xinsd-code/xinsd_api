'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ApiForwardConfig, CustomParamDef, ParamBinding, MockAPI, ApiClientConfig, KeyValuePair, OrchestrationConfig } from '@/lib/types';
import JsonEditor from '@/components/JsonEditor';
import OrchestrationEditor from '@/components/OrchestrationEditor';
import { Icons } from '@/components/Icons';
import styles from './page.module.css';

function CustomParamEditor({
  params,
  onChange,
}: {
  params: CustomParamDef[];
  onChange: (params: CustomParamDef[]) => void;
}) {
  const handleAdd = () => {
    onChange([...params, { key: '', type: 'string', description: '', defaultValue: '' }]);
  };

  const handleUpdate = (index: number, field: keyof CustomParamDef, value: string) => {
    const newParams = [...params];
    newParams[index] = { ...newParams[index], [field]: value };
    onChange(newParams);
  };

  const handleRemove = (index: number) => {
    onChange(params.filter((_, i) => i !== index));
  };

  return (
    <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
      <div className="section-header" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Layers size={18} />
          <h3 className="section-title">输入参数定义</h3>
        </div>
        <button onClick={handleAdd} className="btn btn-secondary btn-sm">
          <Icons.Plus size={14} />
          添加参数
        </button>
      </div>
      
      {params.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {params.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: '12px', alignItems: 'center', padding: '12px', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
              <input
                type="text"
                placeholder="键名"
                value={p.key}
                onChange={(e) => handleUpdate(i, 'key', e.target.value)}
                className="form-input" style={{ flex: 1.5, height: 36 }}
              />
              <select
                value={p.type}
                onChange={(e) => handleUpdate(i, 'type', e.target.value)}
                className="form-select" style={{ width: '110px', height: 36 }}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="integer">integer</option>
                <option value="boolean">boolean</option>
                <option value="array">array</option>
              </select>
              <input
                type="text"
                placeholder="默认值"
                value={p.defaultValue || ''}
                onChange={(e) => handleUpdate(i, 'defaultValue', e.target.value)}
                className="form-input" style={{ flex: 1.5, height: 36 }}
              />
              <input
                type="text"
                placeholder="描述说明"
                value={p.description || ''}
                onChange={(e) => handleUpdate(i, 'description', e.target.value)}
                className="form-input" style={{ flex: 2, height: 36 }}
              />
              <button
                onClick={() => handleRemove(i)}
                className="btn btn-ghost btn-icon btn-sm" style={{ color: 'var(--color-danger)' }}
              >
                <Icons.Trash size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ padding: '32px', textAlign: 'center', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-lg)', color: 'var(--color-text-muted)', fontSize: 13, border: '1px dashed var(--color-border)' }}>
          未定义输入参数。
        </div>
      )}
    </div>
  );
}

function ParamBindingEditor({
  targetParams,
  customParams,
  bindings,
  onChange,
}: {
  targetParams: KeyValuePair[];
  customParams: CustomParamDef[];
  bindings: ParamBinding[];
  onChange: (bindings: ParamBinding[]) => void;
}) {
  const getBindingFor = (targetKey: string) => {
    return bindings.find(b => b.targetParamKey === targetKey);
  };

  const handleUpdate = (targetKey: string, customKey: string, staticVal: string) => {
    const newBindings = bindings.filter(b => b.targetParamKey !== targetKey);
    newBindings.push({ targetParamKey: targetKey, customParamKey: customKey || undefined, staticValue: staticVal || undefined });
    onChange(newBindings);
  };

  if (targetParams.length === 0) {
    return null;
  }

  return (
    <div style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <Icons.Refresh size={16} />
        <h3 style={{ fontSize: 15, fontWeight: 800 }}>参数映射绑定</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {targetParams.map((tp, i) => {
          const binding = getBindingFor(tp.key);
          const isMappingStatic = !!binding?.staticValue;
          
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', background: 'white', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>{tp.key}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>目标接口参数</div>
              </div>
              
              <Icons.ChevronRight size={16} style={{ color: 'var(--color-text-muted)' }} />
              
              <div style={{ flex: 2, display: 'flex', gap: 8 }}>
                <select 
                  className="form-select" style={{ flex: 1, height: 36, fontSize: 13, minWidth: '140px' }}
                  value={isMappingStatic ? '__static__' : (binding?.customParamKey || '')}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '__static__') {
                      handleUpdate(tp.key, '', binding?.staticValue || '');
                    } else if (val) {
                      handleUpdate(tp.key, val, '');
                    } else {
                      handleUpdate(tp.key, '', '');
                    }
                  }}
                >
                  <option value="">-- 未绑定 --</option>
                  <optgroup label="自定义输入参数">
                    {customParams.map(cp => (
                      <option key={cp.key} value={cp.key}>{cp.key} ({cp.type})</option>
                    ))}
                  </optgroup>
                  <option value="__static__">固定静态值</option>
                </select>
                
                {isMappingStatic && (
                  <input 
                    type="text" 
                    placeholder="输入固定值" 
                    className="form-input" style={{ flex: 1, height: 36, fontSize: 13 }}
                    value={binding?.staticValue || ''}
                    onChange={(e) => handleUpdate(tp.key, '', e.target.value)}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  );
}

export default function ApiForwardPage() {
  const [forwards, setForwards] = useState<ApiForwardConfig[]>([]);
  const [mocks, setMocks] = useState<MockAPI[]>([]);
  const [apiClients, setApiClients] = useState<ApiClientConfig[]>([]);
  
  const [activeId, setActiveId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // 编辑器状态
  const [name, setName] = useState('');
  const [apiGroup, setApiGroup] = useState('未分组');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState('');
  const [path, setPath] = useState('');
  
  const [customParams, setCustomParams] = useState<CustomParamDef[]>([]);
  const [targetType, setTargetType] = useState<'mock' | 'api-client'>('api-client');
  const [targetId, setTargetId] = useState<string>('');
  const [paramBindings, setParamBindings] = useState<ParamBinding[]>([]);
  const [orchestration, setOrchestration] = useState<OrchestrationConfig>({ nodes: [] });

  const [viewMode, setViewMode] = useState<'design' | 'run'>('design');
  const [runParams, setRunParams] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<any>(null);
  const [runStatus, setRunStatus] = useState<number | null>(null);
  const [runTime, setRunTime] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    fetchForwards();
    fetchTargets();
  }, []);

  const fetchForwards = async () => {
    try {
      const res = await fetch('/api/forwards');
      if (res.ok) {
        const data = await res.json();
        setForwards(data);
      }
    } catch (e) {
      console.error('Failed to fetch forwards', e);
    }
  };

  const fetchTargets = async () => {
    try {
      const [mockRes, clientRes] = await Promise.all([
        fetch('/api/mocks'),
        fetch('/api/api-client')
      ]);
      if (mockRes.ok) setMocks(await mockRes.json());
      if (clientRes.ok) setApiClients(await clientRes.json());
    } catch (e) {
      console.error('Failed to fetch targets', e);
    }
  };

  const activeForward = useMemo(() => forwards.find(f => f.id === activeId), [forwards, activeId]);

  useEffect(() => {
    if (activeForward) {
      setName(activeForward.name);
      setApiGroup(activeForward.apiGroup || '未分组');
      setDescription(activeForward.description || '');
      setMethod(activeForward.method);
      setPath(activeForward.path);
      setCustomParams(activeForward.customParams || []);
      setTargetType(activeForward.targetType);
      setTargetId(activeForward.targetId);
      setParamBindings(activeForward.paramBindings || []);
      setOrchestration(activeForward.orchestration || { nodes: [] });
      setViewMode('design');
      setRunResult(null);
      setRunStatus(null);
      
      const initialRunParams: Record<string, string> = {};
      (activeForward.customParams || []).forEach(p => {
        initialRunParams[p.key] = p.defaultValue || '';
      });
      setRunParams(initialRunParams);
    }
  }, [activeId, activeForward]);

  const handleCreateNew = () => {
    setActiveId(null);
    setName('新建转发接口');
    setApiGroup('未分组');
    setDescription('');
    setMethod('POST');
    setPath('/forward/' + Math.random().toString(36).substring(7));
    setCustomParams([]);
    setTargetType('api-client');
    setTargetId('');
    setParamBindings([]);
    setOrchestration({ nodes: [] });
    setViewMode('design');
    setRunResult(null);
  };

  const handleSave = async () => {
    const payload = {
      name, apiGroup, description, method, path, customParams, targetType, targetId, paramBindings, orchestration
    };

    try {
      const res = activeId 
        ? await fetch(`/api/forwards/${activeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          })
        : await fetch('/api/forwards', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

      if (res.ok) {
        const saved = await res.json();
        await fetchForwards();
        if (!activeId) {
          setActiveId(saved.id);
        }
        showToast('配置已保存');
      } else {
        showToast('保存失败', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('保存时发生错误', 'error');
    }
  };

  const handleDelete = async () => {
    if (!activeId || !confirm('确定要删除这个转发接口吗？')) return;
    try {
      const res = await fetch(`/api/forwards/${activeId}`, { method: 'DELETE' });
      if (res.ok) {
        setActiveId(null);
        showToast('接口已删除');
        fetchForwards();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRun = async () => {
    const currentConfig: ApiForwardConfig = {
      id: activeId || 'temp_id',
      name,
      apiGroup,
      description,
      method,
      path,
      customParams,
      targetType,
      targetId,
      paramBindings,
      orchestration,
      createdAt: '',
      updatedAt: ''
    };

    setIsLoading(true);
    setRunResult(null);
    setRunStatus(null);
    
    const target = targetType === 'mock' 
      ? mocks.find(m => m.id === targetId)
      : apiClients.find(c => c.id === targetId);
      
    if (!target) {
      showToast('未找到目标接口', 'error');
      setIsLoading(false);
      return;
    }

    try {
      const startTime = Date.now();
      const res = await fetch('/api/forwards/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          forwardConfig: currentConfig,
          runParams: runParams
        })
      });
      
      setRunTime(Date.now() - startTime);
      setRunStatus(res.status);
      
      const text = await res.text();
      try {
        setRunResult(JSON.parse(text));
      } catch {
        setRunResult(text);
      }
    } catch (error: any) {
      setRunResult({ error: error.message });
      setRunStatus(0);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredForwards = forwards.filter(f => 
    f.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    f.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const groupedForwards = filteredForwards.reduce((acc, current) => {
    const group = current.apiGroup || '未分组';
    if (!acc[group]) acc[group] = [];
    acc[group].push(current);
    return acc;
  }, {} as Record<string, ApiForwardConfig[]>);

  const renderDesignMode = () => {
    let targetParams: KeyValuePair[] = [];
    if (targetType === 'mock') {
      const t = mocks.find(m => m.id === targetId);
      if (t) targetParams = t.requestParams;
    } else {
      const t = apiClients.find(c => c.id === targetId);
      if (t) targetParams = t.requestParams;
    }

    return (
      <div className={styles.configPanel}>
        <div className={styles.panelContent} style={{ padding: 24 }}>
          <CustomParamEditor params={customParams} onChange={setCustomParams} />

          <div className="card" style={{ padding: '24px', marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <Icons.Server size={18} />
              <h3 className="section-title">后端服务绑定</h3>
            </div>
            <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">服务类型</label>
                <select
                  value={targetType}
                  onChange={(e) => {
                    setTargetType(e.target.value as 'mock' | 'api-client');
                    setTargetId('');
                    setParamBindings([]);
                  }}
                  className="form-select"
                >
                  <option value="api-client">API 接入 (第三方接口)</option>
                  <option value="mock">Mock 接口 (内部模拟)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">目标接口</label>
                <select
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setParamBindings([]);
                  }}
                  className="form-select"
                >
                  <option value="">-- 选择目标端点 --</option>
                  {targetType === 'mock' 
                    ? mocks.map(m => <option key={m.id} value={m.id}>[{m.apiGroup}] {m.name}</option>)
                    : apiClients.map(c => <option key={c.id} value={c.id}>[{c.apiGroup}] {c.name}</option>)
                  }
                </select>
              </div>
            </div>
            
            {targetId && (
              <ParamBindingEditor 
                targetParams={targetParams} 
                customParams={customParams} 
                bindings={paramBindings}
                onChange={setParamBindings} 
              />
            )}
          </div>

          <OrchestrationEditor
            config={orchestration}
            onChange={setOrchestration}
            onSave={handleSave}
            forwardConfig={{
              method,
              path,
              targetType,
              targetId,
              paramBindings,
              customParams,
            }}
            customParams={customParams}
            runParams={runParams}
          />
        </div>
      </div>
    );
  };

  const renderRunMode = () => (
    <div className={styles.configPanel} style={{ borderBottom: 'none' }}>
      <div className={styles.panelContent} style={{ padding: 24 }}>
        <div className="card" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <Icons.Settings size={18} />
            <h3 className="section-title">运行调试参数</h3>
          </div>
          {customParams.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-lg)', color: 'var(--color-text-muted)', fontSize: 13, border: '1px dashed var(--color-border)' }}>
              未定义输入参数，您可以直接执行请求。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {customParams.map(p => (
                <div key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 13, fontWeight: 700 }}>{p.key}</label>
                      {p.description && <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>- {p.description}</span>}
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--color-bg-hover)', padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{p.type}</span>
                  </div>
                  <input
                    type={p.type === 'number' || p.type === 'integer' ? 'number' : 'text'}
                    value={runParams[p.key] || ''}
                    onChange={(e) => setRunParams({ ...runParams, [p.key]: e.target.value })}
                    placeholder={p.defaultValue ? `默认值: ${p.defaultValue}` : `请输入 ${p.key} 的值`}
                    className="form-input"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitle}>
            <span>转发接口列表</span>
            <button className="btn btn-icon btn-ghost" onClick={handleCreateNew} title="新建转发配置">
              <Icons.Plus size={18} />
            </button>
          </div>
          <div className="search-bar" style={{ maxWidth: '100%' }}>
            <Icons.Search className="search-bar-icon" size={14} />
            <input
              type="text"
              className="search-bar-input"
              style={{ height: '36px' }}
              placeholder="搜索转发配置..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        
        <div className={styles.apiList}>
          {Object.keys(groupedForwards).length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>
              <Icons.Refresh size={48} strokeWidth={1} style={{ opacity: 0.3, marginBottom: 16 }} />
              <div style={{ fontSize: 13 }}>暂无转发配置</div>
            </div>
          ) : (
            Object.entries(groupedForwards).map(([group, list]) => (
              <div key={group} className={styles.apiGroupContainer}>
                <div style={{ 
                  padding: '8px 12px', 
                  fontSize: 11, 
                  fontWeight: 800, 
                  color: 'var(--color-text-muted)', 
                  background: 'var(--color-bg-subtle)', 
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  margin: '2px 4px',
                  borderRadius: 'var(--radius-md)'
                }}>
                  {group}
                </div>
                <div className="stagger-in">
                  {list.map(f => (
                    <div
                      key={f.id}
                      className={`${styles.apiItem} ${activeId === f.id ? styles.active : ''}`}
                      onClick={() => setActiveId(f.id)}
                      style={{ padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid var(--color-bg-subtle)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                        <span className={`method-badge method-${f.method.toLowerCase()}`} style={{ transform: 'scale(0.8)', transformOrigin: 'left' }}>{f.method}</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--font-mono)' }}>{f.path}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className={styles.mainPanel}>
        {!activeId && !name ? (
          <div className={styles.emptyCenter}>
            <div style={{ 
              width: 80, 
              height: 80, 
              background: 'var(--color-bg-subtle)', 
              borderRadius: 'var(--radius-xl)', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center', 
              marginBottom: 24,
              color: 'var(--color-text-muted)'
            }}>
              <Icons.Refresh size={40} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>API 转发与编排</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 24 }}>将入站请求映射到现有端点，并加入自定义处理逻辑。</p>
            <button className="btn btn-primary" onClick={handleCreateNew}>
              <Icons.Plus size={18} />
              新建转发配置
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="form-input"
                    style={{ border: 'none', background: 'transparent', fontSize: 18, fontWeight: 800, padding: 0, height: 'auto', marginBottom: 2 }}
                    placeholder="请输入转发名称"
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icons.Layers size={12} style={{ color: 'var(--color-text-muted)' }} />
                    <input
                      type="text"
                      onChange={(e) => setApiGroup(e.target.value)}
                      value={apiGroup}
                      className="form-input"
                      style={{ width: 140, height: 'auto', fontSize: 12, padding: 0, border: 'none', background: 'transparent', fontWeight: 600, color: 'var(--color-text-secondary)' }}
                      placeholder="分组名称..."
                    />
                  </div>
                </div>
                
                <div className="tabs" style={{ margin: 0, height: 40, width: 240 }}>
                  <button 
                    className={`tab ${viewMode === 'design' ? 'active' : ''}`} 
                    onClick={() => setViewMode('design')}
                  >
                    配置设计
                  </button>
                  <button 
                    className={`tab ${viewMode === 'run' ? 'active' : ''}`} 
                    onClick={() => setViewMode('run')}
                  >
                    运行调试
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                {activeId && (
                  <button className="btn btn-ghost btn-icon" onClick={handleDelete} title="删除">
                    <Icons.Trash size={18} style={{ color: 'var(--color-danger)' }} />
                  </button>
                )}
                <button className="btn btn-primary" onClick={handleSave}>
                  保存转发配置
                </button>
              </div>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '24px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-subtle)' }}>
                <div style={{ display: 'flex', gap: 12, maxWidth: 1000 }}>
                  <div style={{ display: 'flex', flex: 1, background: 'white', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
                    <select
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      className="form-select"
                      style={{ width: '110px', border: 'none', borderRight: '1px solid var(--color-border)', borderRadius: 0, fontWeight: 700, fontSize: 13, height: '42px' }}
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="DELETE">DELETE</option>
                      <option value="PATCH">PATCH</option>
                    </select>
                    <input
                      type="text"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      className="form-input"
                      style={{ flex: 1, border: 'none', fontFamily: 'var(--font-mono)', fontSize: 13 }}
                      placeholder="/api/v1/forward/endpoint"
                    />
                  </div>
                  <button 
                    className="btn btn-primary" 
                    onClick={handleRun}
                    disabled={isLoading}
                    style={{ width: 120, height: 42 }}
                  >
                    {isLoading ? <div style={{ width: 16, height: 16, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div> : <Icons.Zap size={18} />}
                    {isLoading ? '' : '执行测试'}
                  </button>
                </div>
              </div>

              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <div style={{ flex: 1, overflowY: 'auto', borderRight: '1px solid var(--color-border)' }}>
                  {viewMode === 'design' ? renderDesignMode() : renderRunMode()}
                </div>
                
                {runResult && (
                  <div style={{ flex: 1, background: 'var(--color-bg-subtle)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'white' }}>
                      <div style={{ display: 'flex', gap: 16 }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>响应状态</span>
                          <span style={{ 
                            fontSize: 14, 
                            fontWeight: 800, 
                            color: runStatus && runStatus >= 200 && runStatus < 300 ? 'var(--color-success)' : 'var(--color-danger)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6
                          }}>
                            {runStatus && runStatus >= 200 && runStatus < 300 ? <Icons.Check size={14} /> : <Icons.Info size={14} />}
                            {runStatus || '错误'}
                          </span>
                        </div>
                        <div style={{ width: 1, height: 24, background: 'var(--color-border)', alignSelf: 'center' }}></div>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 2 }}>执行耗时</span>
                          <span style={{ fontSize: 14, fontWeight: 800 }}>{runTime} ms</span>
                        </div>
                      </div>
                      
                      <button className="btn btn-secondary btn-sm" onClick={() => setRunResult(null)}>
                        清除结果
                      </button>
                    </div>
                    
                    <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
                      <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ padding: '8px 16px', background: 'var(--color-bg-subtle)', borderBottom: '1px solid var(--color-border)', fontSize: 11, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
                          运行输出结果
                        </div>
                        <JsonEditor
                          value={typeof runResult === 'string' ? runResult : JSON.stringify(runResult, null, 2)}
                          onChange={() => {}}
                          height={400}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.type === 'success' ? <Icons.Check size={18} /> : <Icons.Info size={18} />}
          {toast.message}
        </div>
      )}
      
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { to { transform: rotate(360deg); } }
      `}} />
    </div>
  );
}
