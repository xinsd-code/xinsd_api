'use client';

import { useState } from 'react';
import { MockAPI, KeyValuePair, StreamConfig } from '@/lib/types';
import KeyValueEditor from './KeyValueEditor';
import StreamConfigEditor from './StreamConfigEditor';
import JsonEditor from './JsonEditor';
import { Icons } from './Icons';

interface MockEditorProps {
  mock?: MockAPI | null;
  onSave: (data: Partial<MockAPI>) => void;
  onClose: () => void;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

const DEFAULT_RESPONSE_BODY = JSON.stringify(
  {
    code: 200,
    message: 'success',
    data: {},
  },
  null,
  2
);

type TabKey = 'basic' | 'request' | 'response' | 'stream';

export default function MockEditor({ mock, onSave, onClose }: MockEditorProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('basic');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [name, setName] = useState(mock?.name || '');
  const [path, setPath] = useState(mock?.path || '');
  const [method, setMethod] = useState(mock?.method || 'GET');
  const [description, setDescription] = useState(mock?.description || '');
  const [apiGroup, setApiGroup] = useState(mock?.apiGroup || '未分组');
  const [enabled, setEnabled] = useState(mock?.enabled ?? true);

  const [requestHeaders, setRequestHeaders] = useState<KeyValuePair[]>(mock?.requestHeaders || []);
  const [requestParams, setRequestParams] = useState<KeyValuePair[]>(mock?.requestParams || []);

  const [responseStatus, setResponseStatus] = useState(mock?.responseStatus || 200);
  const [responseHeaders, setResponseHeaders] = useState<KeyValuePair[]>(mock?.responseHeaders || []);
  const [responseBody, setResponseBody] = useState(mock?.responseBody || DEFAULT_RESPONSE_BODY);
  const [responseDelay, setResponseDelay] = useState(mock?.responseDelay || 0);

  const [isStream, setIsStream] = useState(mock?.isStream || false);
  const [streamConfig, setStreamConfig] = useState<StreamConfig>(mock?.streamConfig || {
    chunkDelay: 100,
    chunks: [],
  });

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = '请输入接口名称';
    if (!path.trim()) newErrors.path = '请输入接口路径';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) {
      setActiveTab('basic');
      return;
    }

    onSave({
      name: name.trim(),
      path: path.trim().startsWith('/') ? path.trim() : '/' + path.trim(),
      method,
      description: description.trim(),
      apiGroup: apiGroup.trim() || '未分组',
      enabled,
      requestHeaders: requestHeaders.filter((h) => h.key),
      requestParams: requestParams.filter((p) => p.key),
      responseStatus,
      responseHeaders: responseHeaders.filter((h) => h.key),
      responseBody,
      responseDelay,
      isStream,
      streamConfig,
    });
  };

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'basic', label: '基本信息', icon: <Icons.Info size={14} /> },
    { key: 'request', label: '请求参数', icon: <Icons.Zap size={14} /> },
    { key: 'response', label: '响应配置', icon: <Icons.Code size={14} /> },
    { key: 'stream', label: '流式响应', icon: <Icons.Activity size={14} /> },
  ];

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content">
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{mock ? '编辑 Mock 接口' : '新建 Mock 接口'}</h2>
            <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
              配置 Mock 端点的属性、匹配规则及返回行为。
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <Icons.X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`tab ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.icon}
                <span style={{ marginLeft: '8px' }}>{tab.label}</span>
              </button>
            ))}
          </div>

          <div style={{ minHeight: '400px' }}>
            {activeTab === 'basic' && (
              <div className="stagger-in">
                <div className="form-group">
                  <label className="form-label">接口名称</label>
                  <input
                    className={`form-input ${errors.name ? 'error' : ''}`}
                    placeholder="例如: 获取用户资料"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (errors.name) setErrors({ ...errors, name: '' });
                    }}
                  />
                  {errors.name && <p style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{errors.name}</p>}
                </div>

                <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div className="form-group">
                    <label className="form-label">请求方法</label>
                    <select
                      className="form-select"
                      style={{ height: '38px' }}
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                    >
                      {HTTP_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">HTTP 状态码</label>
                    <input
                      type="number"
                      className="form-input"
                      value={responseStatus}
                      onChange={(e) => setResponseStatus(parseInt(e.target.value) || 200)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    接口路径 <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(支持 :id 等路径参数)</span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>/mock</span>
                    <input
                      className={`form-input ${errors.path ? 'error' : ''}`}
                      style={{ paddingLeft: '60px', fontFamily: 'var(--font-mono)' }}
                      placeholder="/api/v1/users/:id"
                      value={path}
                      onChange={(e) => {
                        setPath(e.target.value);
                        if (errors.path) setErrors({ ...errors, path: '' });
                      }}
                    />
                  </div>
                  {errors.path && <p style={{ color: 'var(--color-danger)', fontSize: '12px', marginTop: '4px' }}>{errors.path}</p>}
                </div>

                <div className="form-group">
                  <label className="form-label">功能描述</label>
                  <input
                    className="form-input"
                    placeholder="可选的接口用途说明..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>

                <div className="form-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div className="form-group">
                    <label className="form-label">所属分组</label>
                    <input
                      className="form-input"
                      placeholder="例如: 用户模块"
                      value={apiGroup}
                      onChange={(e) => setApiGroup(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">响应延迟 (ms)</label>
                    <input
                      type="number"
                      className="form-input"
                      value={responseDelay}
                      onChange={(e) => setResponseDelay(parseInt(e.target.value) || 0)}
                      min={0}
                    />
                  </div>
                </div>

                <div className="form-group" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', background: 'var(--color-bg-subtle)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)' }}>
                  <div>
                    <label className="form-label" style={{ marginBottom: '2px' }}>启用接口</label>
                    <p style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>禁用后，该 Mock 路径将返回 404。</p>
                  </div>
                  <button
                    className={`status-toggle ${enabled ? 'active' : ''}`}
                    onClick={() => setEnabled(!enabled)}
                  />
                </div>
              </div>
            )}

            {activeTab === 'request' && (
              <div className="stagger-in">
                <div className="form-group">
                  <label className="form-label">请求头匹配</label>
                  <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '16px' }}>
                    配置此 Mock 接口需要匹配的特定请求头。
                  </p>
                  <KeyValueEditor
                    items={requestHeaders}
                    onChange={setRequestHeaders}
                    keyPlaceholder="Header Key"
                    valuePlaceholder="期望的值 (可选)"
                  />
                </div>

                <div className="form-group" style={{ marginTop: '32px' }}>
                  <label className="form-label">参数匹配</label>
                  <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '16px' }}>
                    匹配特定的 Query 或 Body 参数。
                  </p>
                  <KeyValueEditor
                    items={requestParams}
                    onChange={setRequestParams}
                    keyPlaceholder="参数名"
                    valuePlaceholder="期望的值 (可选)"
                  />
                </div>
              </div>
            )}

            {activeTab === 'response' && (
              <div className="stagger-in">
                <div className="form-group">
                  <label className="form-label">自定义响应头</label>
                  <KeyValueEditor
                    items={responseHeaders}
                    onChange={setResponseHeaders}
                    keyPlaceholder="Header Key"
                    valuePlaceholder="Header Value"
                  />
                </div>

                <div className="form-group" style={{ marginTop: '24px' }}>
                  <label className="form-label">
                    响应体内容 <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(支持变量注入)</span>
                  </label>
                  <div className="editor-container" style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    <JsonEditor
                      value={responseBody}
                      onChange={setResponseBody}
                      height={280}
                    />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'stream' && (
              <div className="stagger-in">
                <div className="form-group" style={{ background: 'var(--color-bg-subtle)', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <h4 style={{ fontSize: '14px', fontWeight: 700 }}>开启流式响应 (SSE)</h4>
                      <p style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                        模拟 Server-Sent Events，以分块方式逐条返回数据。
                      </p>
                    </div>
                    <button
                      className={`status-toggle ${isStream ? 'active' : ''}`}
                      onClick={() => setIsStream(!isStream)}
                    />
                  </div>
                </div>

                {isStream && (
                  <div style={{ marginTop: '24px' }}>
                    <StreamConfigEditor
                      config={streamConfig}
                      onChange={setStreamConfig}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {mock ? '保存修改' : '创建接口'}
          </button>
        </div>
      </div>
      <style jsx>{`
        .form-input.error {
          border-color: var(--color-danger);
          background-color: var(--color-danger-soft);
        }
      `}</style>
    </div>
  );
}
