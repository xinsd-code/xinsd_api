'use client';

import { useState, useEffect, useMemo } from 'react';
import { ApiForwardConfig, CustomParamDef, ParamBinding, MockAPI, ApiClientConfig, KeyValuePair } from '@/lib/types';
import JsonEditor from '@/components/JsonEditor';
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
      <div className="section-header">
        <h3 className="section-title">自定义入参定义</h3>
        <button onClick={handleAdd} className="btn btn-secondary btn-sm">
          + 添加参数
        </button>
      </div>
      
      {params.length === 0 ? (
        <div className="emptyCenter" style={{ minHeight: '120px', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          <div>暂无自定义参数，点击右上角添加</div>
        </div>
      ) : (
        <div>
          {params.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="参数名 (key)"
                value={p.key}
                onChange={(e) => handleUpdate(i, 'key', e.target.value)}
                className="form-input" style={{ flex: 1.5 }}
              />
              <select
                value={p.type}
                onChange={(e) => handleUpdate(i, 'type', e.target.value)}
                className="form-select" style={{ width: '120px' }}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="integer">integer</option>
                <option value="boolean">boolean</option>
                <option value="array">array</option>
              </select>
              <input
                type="text"
                placeholder="默认值 (可选)"
                value={p.defaultValue || ''}
                onChange={(e) => handleUpdate(i, 'defaultValue', e.target.value)}
                className="form-input" style={{ flex: 1.5 }}
              />
              <input
                type="text"
                placeholder="描述说明"
                value={p.description || ''}
                onChange={(e) => handleUpdate(i, 'description', e.target.value)}
                className="form-input" style={{ flex: 2 }}
              />
              <button
                onClick={() => handleRemove(i)}
                className="btn btn-ghost btn-icon" style={{ color: 'var(--color-danger)' }}
                title="删除参数"
              >
                ✕
              </button>
            </div>
          ))}
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
    return (
      <div className="emptyCenter" style={{ minHeight: '100px', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)', marginTop: '20px' }}>
        <div>选中的底层接口暂无入参需要映射</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '20px' }}>
      <h3 className="section-title" style={{ marginBottom: '16px' }}>参数映射 (连线)</h3>
      <div>
        {targetParams.map((tp, i) => {
          const binding = getBindingFor(tp.key);
          const isMappingCustom = !!binding?.customParamKey;
          const isMappingStatic = !!binding?.staticValue;
          
          return (
            <div key={i} className={styles.bindingRow}>
              <div className={styles.bindingTarget}>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>{tp.key}</div>
                <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>底层目标参数</div>
              </div>
              
              <div className={styles.bindingArrow}>{'<='}</div>
              
              <div className={styles.bindingSource}>
                <select 
                  className="form-select" style={{ flex: 1 }}
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
                  <option value="">-- 未映射 (不传递) --</option>
                  <optgroup label="自定义入参">
                    {customParams.map(cp => (
                      <option key={cp.key} value={cp.key}>{cp.key} ({cp.type})</option>
                    ))}
                  </optgroup>
                  <option value="__static__">固定静态值</option>
                </select>
                
                {isMappingStatic && (
                  <input 
                    type="text" 
                    placeholder="请输入静态值" 
                    className="form-input" style={{ flex: 1 }}
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

// --- Main Page Component ---
export default function ApiForwardPage() {
  const [forwards, setForwards] = useState<ApiForwardConfig[]>([]);
  const [mocks, setMocks] = useState<MockAPI[]>([]);
  const [apiClients, setApiClients] = useState<ApiClientConfig[]>([]);
  
  const [activeId, setActiveId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Editor State
  const [name, setName] = useState('');
  const [apiGroup, setApiGroup] = useState('未分组');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState('');
  const [path, setPath] = useState('');
  
  const [customParams, setCustomParams] = useState<CustomParamDef[]>([]);
  const [targetType, setTargetType] = useState<'mock' | 'api-client'>('api-client');
  const [targetId, setTargetId] = useState<string>('');
  const [paramBindings, setParamBindings] = useState<ParamBinding[]>([]);

  const [viewMode, setViewMode] = useState<'design' | 'run'>('design');
  const [runParams, setRunParams] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<any>(null);
  const [runStatus, setRunStatus] = useState<number | null>(null);
  const [runTime, setRunTime] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);

  // Fetch initial data
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

  // Set editor state when activeId changes
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
    setName('New Forward API');
    setApiGroup('未分组');
    setDescription('');
    setMethod('POST');
    setPath('/forward/' + Math.random().toString(36).substring(7));
    setCustomParams([]);
    setTargetType('api-client');
    setTargetId('');
    setParamBindings([]);
    setViewMode('design');
    setRunResult(null);
  };

  const handleSave = async () => {
    const payload = {
      name, apiGroup, description, method, path, customParams, targetType, targetId, paramBindings
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
        
        // Show success toast (a simple implementation)
        const toast = document.createElement('div');
        toast.className = 'toast toast-success';
        toast.textContent = '保存成功';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      } else {
        alert('保存失败');
      }
    } catch (e) {
      console.error(e);
      alert('保存失败');
    }
  };

  const handleDelete = async () => {
    if (!activeId || !confirm('确认删除该接口转发?')) return;
    try {
      const res = await fetch(`/api/forwards/${activeId}`, { method: 'DELETE' });
      if (res.ok) {
        setActiveId(null);
        fetchForwards();
      }
    } catch (e) {
      console.error(e);
    }
  };

    const handleRun = async () => {
    // Construct the current state config instead of relying solely on the saved activeForward
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
      alert('绑定的目标接口不存在，请检查配置');
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
        <div className={styles.panelContent}>
          <CustomParamEditor params={customParams} onChange={setCustomParams} />

          <div className="card" style={{ padding: '24px' }}>
            <h3 className="section-title" style={{ marginBottom: '20px' }}>底层服务绑定</h3>
            <div className="form-row">
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
                  <option value="api-client">API 接入 (Third-Party API)</option>
                  <option value="mock">Mock 接入 (Mock API)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">选择具体接口</label>
                <select
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setParamBindings([]);
                  }}
                  className="form-select"
                >
                  <option value="">-- 请选择 --</option>
                  {targetType === 'mock' 
                    ? mocks.map(m => <option key={m.id} value={m.id}>[{m.apiGroup}] {m.name} ({m.path})</option>)
                    : apiClients.map(c => <option key={c.id} value={c.id}>[{c.apiGroup}] {c.name} ({c.url})</option>)
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
        </div>
      </div>
    );
  };

  const renderRunMode = () => (
    <div className={styles.configPanel} style={{ borderBottom: 'none' }}>
      <div className={styles.panelContent}>
        <div className="card" style={{ padding: '24px' }}>
          <h3 className="section-title" style={{ marginBottom: '20px' }}>入参填写 (Run Parameters)</h3>
          {customParams.length === 0 ? (
            <div className="emptyCenter" style={{ minHeight: '100px', background: 'var(--color-bg-hover)', borderRadius: 'var(--radius-md)' }}>
              <div>该转发接口未定义任何自定义入参，可以直接点击【发送】测试。</div>
            </div>
          ) : (
            <div>
              {customParams.map(p => (
                <div key={p.key} className={styles.runFormRow}>
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {p.key}
                    <span className="method-badge" style={{ background: 'var(--color-bg-badge)', color: 'var(--color-text-secondary)' }}>{p.type}</span>
                    {p.description && <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--color-text-muted)' }}>- {p.description}</span>}
                  </label>
                  <input
                    type={p.type === 'number' || p.type === 'integer' ? 'number' : 'text'}
                    value={runParams[p.key] || ''}
                    onChange={(e) => setRunParams({ ...runParams, [p.key]: e.target.value })}
                    placeholder={p.defaultValue ? `默认值: ${p.defaultValue}` : `输入 ${p.key}`}
                    className="form-input form-input-mono"
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
            <span>接口转发列表</span>
            <button className="btn btn-icon btn-ghost" onClick={handleCreateNew} title="新建转发">
              +
            </button>
          </div>
          <div className="search-bar">
            <span className="search-bar-icon">🔍</span>
            <input
              type="text"
              className="form-input"
              style={{ borderRadius: '20px', fontSize: '13px' }}
              placeholder="搜索接口..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
        
        <div className={styles.apiList}>
          {Object.keys(groupedForwards).length === 0 ? (
            <div className={styles.emptyCenter}>
              <span style={{ fontSize: '24px' }}>🔄</span>
              <span>暂无接口转发</span>
            </div>
          ) : (
            Object.entries(groupedForwards).map(([group, list]) => (
              <div key={group} style={{ padding: '8px 0' }}>
                <div style={{ padding: '4px 16px', fontSize: '12px', fontWeight: 600, color: 'var(--color-text-muted)', background: 'var(--color-bg-card)', position: 'sticky', top: 0 }}>
                  {group}
                </div>
                <div>
                  {list.map(f => (
                    <div
                      key={f.id}
                      className={`${styles.apiItem} ${activeId === f.id ? styles.active : ''}`}
                      onClick={() => setActiveId(f.id)}
                    >
                      <div className={styles.apiItemHeader}>
                        <span className={`method-badge method-${f.method.toLowerCase()}`}>{f.method}</span>
                        <span className={styles.apiItemName}>{f.name}</span>
                      </div>
                      <div className={styles.apiItemUrl}>{f.path}</div>
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
            <div style={{ fontSize: 48 }}>⚡</div>
            <div>选择左侧接口或新建一个接口进行测试</div>
            <button className="btn btn-primary" onClick={handleCreateNew}>新建接口</button>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="form-input"
                  style={{ width: 200, border: 'none', background: 'transparent', fontSize: 16, fontWeight: 600, padding: 0 }}
                  placeholder="接口名称"
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-bg-subtle)', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)' }}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>📂</span>
                  <input
                    type="text"
                    onChange={(e) => setApiGroup(e.target.value)}
                    value={apiGroup}
                    className="form-input"
                    style={{ width: 120, height: 20, fontSize: 12, padding: 0, border: 'none', background: 'transparent' }}
                    placeholder="所属分组..."
                  />
                </div>
                <div className="tabs" style={{ margin: 0 }}>
                  <button 
                    className={`tab ${viewMode === 'design' ? 'active' : ''}`} 
                    onClick={() => setViewMode('design')}
                    style={{ padding: '4px 12px', fontSize: 13 }}
                  >
                    配置模式 (Design)
                  </button>
                  <button 
                    className={`tab ${viewMode === 'run' ? 'active' : ''}`} 
                    onClick={() => setViewMode('run')}
                    style={{ padding: '4px 12px', fontSize: 13 }}
                  >
                    运行调试 (Run)
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {activeId && (
                  <button onClick={handleDelete} className="btn btn-danger btn-sm">删除</button>
                )}
                <button onClick={handleSave} className="btn btn-secondary btn-sm">保存配置</button>
              </div>
            </div>

            {/* Request Bar */}
            <div className={styles.requestBar}>
              <div className={styles.urlInput}>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="form-select"
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                  <option value="OPTIONS">OPTIONS</option>
                  <option value="HEAD">HEAD</option>
                </select>
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  className="form-input"
                  placeholder="暴露的 API 路径，如 /forward/my-service"
                />
              </div>
              <button 
                className="btn btn-primary" 
                onClick={handleRun}
                disabled={isLoading}
                style={{ width: 100, justifyContent: 'center' }}
              >
                {isLoading ? '发送中...' : '发 送'}
              </button>
            </div>

            <div className={styles.editorBody}>
              <div className={styles.panels} style={{ display: 'flex', width: '100%', height: '100%', gap: '16px', overflow: 'hidden' }}>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  {viewMode === 'design' ? renderDesignMode() : renderRunMode()}
                </div>
                {runResult && (
                  <div className={styles.responsePanel} style={{ borderLeft: '1px solid var(--color-border)', flex: 1, height: '100%', overflowY: 'auto' }}>
                    <div className={styles.responseHeader}>
                      <span className={runStatus && runStatus >= 200 && runStatus < 300 ? styles.statusOk : styles.statusErr}>
                        状态码: {runStatus || 'Error'}
                      </span>
                      <span>耗时: <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{runTime} ms</span></span>
                    </div>
                    <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <JsonEditor
                        value={typeof runResult === 'string' ? runResult : JSON.stringify(runResult, null, 2)}
                        onChange={() => {}}
                        height={250}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
