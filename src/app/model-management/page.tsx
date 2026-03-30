'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildAiChatEndpoint,
  sanitizeAIModelProfileInput,
  validateAIModelProfileInput,
} from '@/lib/ai-models';
import UnsavedChangesDialog from '@/components/UnsavedChangesDialog';
import { AIModelAuthType, AIModelProfile, AIModelProfileSummary, CreateAIModelProfile } from '@/lib/types';
import { Icons } from '@/components/Icons';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import styles from './page.module.css';

interface EditableProfile {
  name: string;
  baseUrl: string;
  authType: AIModelAuthType;
  authToken: string;
  authHeaderName: string;
  modelIds: string[];
  defaultModelId: string;
  isDefault: boolean;
}

type PanelMode = 'overview' | 'create' | 'edit';

function createEmptyDraft(): EditableProfile {
  return {
    name: '',
    baseUrl: '',
    authType: 'bearer',
    authToken: '',
    authHeaderName: '',
    modelIds: [],
    defaultModelId: '',
    isDefault: false,
  };
}

function toEditableProfile(profile: AIModelProfile): EditableProfile {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    authType: profile.authType,
    authToken: profile.authToken || '',
    authHeaderName: profile.authHeaderName || '',
    modelIds: profile.modelIds || [],
    defaultModelId: profile.defaultModelId || profile.modelIds[0] || '',
    isDefault: profile.isDefault,
  };
}

export default function ModelManagementPage() {
  const [profiles, setProfiles] = useState<AIModelProfileSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>('overview');
  const [draft, setDraft] = useState<EditableProfile>(createEmptyDraft);
  const [modelIdInput, setModelIdInput] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingModelId, setAddingModelId] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [baselineSignature, setBaselineSignature] = useState(() => JSON.stringify(sanitizeAIModelProfileInput(createEmptyDraft())));

  const totalModelCount = useMemo(
    () => profiles.reduce((sum, item) => sum + item.modelIds.length, 0),
    [profiles]
  );
  const defaultProfile = useMemo(
    () => profiles.find((item) => item.isDefault && item.defaultModelId) || null,
    [profiles]
  );
  const payload = useMemo<CreateAIModelProfile>(() => sanitizeAIModelProfileInput({
    name: draft.name,
    baseUrl: draft.baseUrl,
    authType: draft.authType,
    authToken: draft.authToken,
    authHeaderName: draft.authHeaderName,
    modelIds: draft.modelIds,
    defaultModelId: draft.defaultModelId,
    isDefault: draft.isDefault,
  }), [draft]);
  const currentSignature = useMemo(() => JSON.stringify(payload), [payload]);
  const isDirty = currentSignature !== baselineSignature;

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  const resetEditorState = useCallback((mode: PanelMode, profile?: AIModelProfile | null) => {
    const nextDraft = profile ? toEditableProfile(profile) : createEmptyDraft();
    setPanelMode(mode);
    setActiveId(profile?.id || null);
    setDraft(nextDraft);
    setBaselineSignature(JSON.stringify(sanitizeAIModelProfileInput(nextDraft)));
    setModelIdInput('');
  }, []);

  const fetchProfiles = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/ai-models');
      if (!res.ok) {
        throw new Error('获取模型配置失败');
      }
      const data = await res.json() as AIModelProfileSummary[];
      setProfiles(data);
      return data;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '获取模型配置失败', 'error');
      return null;
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void (async () => {
      const data = await fetchProfiles();
      if (!data) return;
      resetEditorState('overview');
    })();
  }, [fetchProfiles, resetEditorState]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const updateDraft = <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const addModelId = async () => {
    const next = modelIdInput.trim();
    if (!next) return;
    if (draft.modelIds.includes(next)) {
      showToast('该 Model ID 已存在，无需重复添加', 'error');
      return;
    }

    const candidatePayload = sanitizeAIModelProfileInput({
      name: draft.name,
      baseUrl: draft.baseUrl,
      authType: draft.authType,
      authToken: draft.authToken,
      authHeaderName: draft.authHeaderName,
      modelIds: [next],
      defaultModelId: next,
      isDefault: draft.isDefault,
    });
    const validationError = validateAIModelProfileInput(candidatePayload);
    if (validationError) {
      showToast(`添加前请先完善当前配置：${validationError}`, 'error');
      return;
    }

    setAddingModelId(true);
    try {
      const res = await fetch('/api/ai-models/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(candidatePayload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Model ID ${next} 不可用`);
      }

      setDraft((prev) => {
        if (prev.modelIds.includes(next)) return prev;
        const nextModelIds = [...prev.modelIds, next];
        return {
          ...prev,
          modelIds: nextModelIds,
          defaultModelId: prev.defaultModelId && nextModelIds.includes(prev.defaultModelId) ? prev.defaultModelId : next,
        };
      });
      setModelIdInput('');
      showToast(`Model ID ${next} 验证通过，已添加`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : `Model ID ${next} 验证失败`, 'error');
    } finally {
      setAddingModelId(false);
    }
  };

  const removeModelId = (modelId: string) => {
    const nextModelIds = draft.modelIds.filter((item) => item !== modelId);
    setDraft((prev) => ({
      ...prev,
      modelIds: nextModelIds,
      defaultModelId: prev.defaultModelId === modelId ? (nextModelIds[0] || '') : prev.defaultModelId,
    }));
  };

  const applyCreateDraft = useCallback(() => {
    resetEditorState('create');
  }, [resetEditorState]);

  const loadProfileDetail = useCallback(async (profile: AIModelProfileSummary) => {
    setActiveId(profile.id);
    setPanelMode('edit');
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/ai-models/${profile.id}`);
      if (!res.ok) throw new Error('读取详情失败');
      const detail = await res.json();
      resetEditorState('edit', detail);
    } catch {
      showToast('获取模型详情失败', 'error');
    } finally {
      setDetailLoading(false);
    }
  }, [resetEditorState, showToast]);

  const validateDraft = useCallback((): string | null => {
    if (!draft.name.trim()) return '请输入模型名称';
    if (!draft.baseUrl.trim()) return '请输入 Base URL';
    if (!draft.modelIds.length) return '请至少添加一个 Model ID';
    if (!draft.defaultModelId) return '请选择默认 Model ID';
    if (draft.authType === 'bearer' && !draft.authToken.trim()) return 'Bearer Token 不能为空';
    if (draft.authType === 'custom-header') {
      if (!draft.authHeaderName.trim()) return '请输入鉴权 Header 名称';
      if (!draft.authToken.trim()) return '请输入鉴权 Header 值';
    }
    return null;
  }, [draft]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    const validationError = validateDraft();
    if (validationError) {
      showToast(validationError, 'error');
      return false;
    }

    setSaving(true);
    try {
      const res = await fetch(activeId ? `/api/ai-models/${activeId}` : '/api/ai-models', {
        method: activeId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '保存模型配置失败');
      }
      const profilesData = await fetchProfiles();
      if (profilesData) {
        if (activeId) {
          resetEditorState('edit', data);
        } else {
          resetEditorState('overview');
        }
      }
      showToast(activeId ? '模型配置已更新' : '模型配置已创建');
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存模型配置失败', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [activeId, fetchProfiles, payload, resetEditorState, showToast, validateDraft]);

  const handleSave = useCallback(() => {
    void saveCurrent();
  }, [saveCurrent]);

  const unsavedGuard = useUnsavedChangesGuard({
    enabled: panelMode === 'create' || panelMode === 'edit',
    isDirty,
    onSave: saveCurrent,
  });

  const handleCreateNew = useCallback(() => {
    unsavedGuard.confirmAction(() => {
      applyCreateDraft();
    });
  }, [applyCreateDraft, unsavedGuard]);

  const handleSelectProfile = useCallback((profile: AIModelProfileSummary) => {
    unsavedGuard.confirmAction(async () => {
      await loadProfileDetail(profile);
    });
  }, [loadProfileDetail, unsavedGuard]);

  const handleDelete = async () => {
    if (!activeId) return;
    if (!window.confirm('确认删除当前模型配置吗？')) return;

    try {
      const res = await fetch(`/api/ai-models/${activeId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '删除模型配置失败');
      }
      const profilesData = await fetchProfiles();
      if (profilesData) {
        resetEditorState('overview');
      }
      showToast('模型配置已删除');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除模型配置失败', 'error');
    }
  };

  const endpointPreview = useMemo(() => buildAiChatEndpoint(draft.baseUrl), [draft.baseUrl]);

  return (
    <div className={styles.workspace}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarEyebrow}>
            <Icons.Sparkles size={14} /> OpenAI Compatible
          </div>
          <div className={styles.sidebarTitle}>
            <div className={styles.sidebarTitleText}>
              <strong>模型管理</strong>
              <span>集中维护 AI Chat 可用模型，支持多 Base URL、多 Model ID 和默认模型切换。</span>
            </div>
            <button className="btn btn-primary btn-icon" onClick={handleCreateNew} title="新增模型配置">
              <Icons.Plus size={18} />
            </button>
          </div>
          <div className={styles.badgeRow}>
            <span className={styles.softBadge}>{profiles.length} 个模型来源</span>
            <span className={styles.softBadge}>{totalModelCount} 个 Model ID</span>
          </div>
        </div>

        <div className={styles.profileList}>
          {loading ? (
            <div className={styles.emptyState}>
              <Icons.Activity size={36} />
              <strong>正在读取模型配置</strong>
              <span>稍等片刻，马上加载完成。</span>
            </div>
          ) : profiles.length === 0 ? (
            <div className={styles.emptyState}>
              <Icons.Sparkles size={42} />
              <strong>先添加第一个模型来源</strong>
              <span>保存后，AI Chat 就可以直接使用默认模型，也支持在对话页中临时切换。</span>
            </div>
          ) : (
            profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`${styles.profileCard} ${panelMode === 'edit' && activeId === profile.id ? styles.active : ''}`}
                onClick={() => handleSelectProfile(profile)}
              >
                <div className={styles.profileHead}>
                  <div>
                    <div className={styles.profileName}>{profile.name}</div>
                    <div className={styles.profileUrl}>{profile.baseUrl}</div>
                  </div>
                  {profile.isDefault && (
                    <span className={`${styles.softBadge} ${styles.defaultBadge}`}>
                      <Icons.Check size={12} /> 默认
                    </span>
                  )}
                </div>
                <div className={styles.badgeRow}>
                  <span className={styles.softBadge}>{profile.modelIds.length} 个 Model ID</span>
                  <span className={styles.softBadge}>{profile.defaultModelId || '未设置默认'}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className={styles.main}>
        {panelMode === 'overview' && (
          <div className={styles.hero}>
            <div>
              <div className={styles.heroTitle}>把 AI Chat 的模型来源，从“启动时写死”升级成可视化配置。</div>
              <div className={styles.heroDesc}>
                这里维护的是 AI Chat 调用模型时真正使用的 OpenAI 兼容配置。每个来源可挂多个 Model ID，并选择一个默认 Model ID；当某个来源被标记为默认时，AI Chat 会优先使用它。
              </div>
              <div className={styles.heroMeta}>
                <span className={styles.softBadge}><Icons.MessageSquare size={12} /> AI Chat 将自动读取默认模型</span>
                <span className={styles.softBadge}><Icons.Refresh size={12} /> 对话页可随时切换到其他已配置模型</span>
                <Link href="/api-forward" className="btn btn-secondary btn-sm">
                  <Icons.ChevronRight size={14} /> 前往 API 转发
                </Link>
              </div>
            </div>
            <div className={styles.statGrid}>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>模型来源</div>
                <div className={styles.statValue}>{profiles.length}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>Model ID</div>
                <div className={styles.statValue}>{totalModelCount}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>默认模型</div>
                <div className={styles.statValue} style={{ fontSize: 18 }}>
                  {defaultProfile ? defaultProfile.defaultModelId : '未设置'}
                </div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>默认来源</div>
                <div className={styles.statValue} style={{ fontSize: 18 }}>
                  {defaultProfile ? defaultProfile.name : '待配置'}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className={styles.panel}>
          {panelMode === 'overview' ? (
            <>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>
                  <strong>模型总览</strong>
                  <span>进入模型管理后默认先看全局概况；点击左侧某个模型来源再进入编辑，点击右上角 + 可直接新建。</span>
                </div>
                <div className={styles.badgeRow}>
                  <span className={styles.softBadge}>{profiles.length} 个来源</span>
                  <span className={styles.softBadge}>{totalModelCount} 个模型</span>
                </div>
              </div>

              <div className={styles.panelBody}>
                <div className={styles.overviewGrid}>
                  <div className={styles.overviewCard}>
                    <div className={styles.overviewLabel}>当前默认来源</div>
                    <div className={styles.overviewValue}>{defaultProfile ? defaultProfile.name : '待配置'}</div>
                    <div className={styles.inlineHint}>AI Chat 将优先使用这个来源及其默认 Model ID。</div>
                  </div>
                  <div className={styles.overviewCard}>
                    <div className={styles.overviewLabel}>默认 Model ID</div>
                    <div className={styles.overviewValue}>{defaultProfile ? defaultProfile.defaultModelId : '未设置'}</div>
                    <div className={styles.inlineHint}>可在模型管理页和 AI Chat 对话页中切换。</div>
                  </div>
                  <div className={styles.overviewCard}>
                    <div className={styles.overviewLabel}>建议操作</div>
                    <div className={styles.overviewValue}>新增或选择一个模型来源</div>
                    <div className={styles.inlineHint}>新建时需要填写 Base URL、鉴权信息，并验证至少一个可用的 Model ID。</div>
                  </div>
                </div>

                <div className={styles.footerMainActions}>
                  <button className="btn btn-primary" type="button" onClick={handleCreateNew}>
                    <Icons.Plus size={16} /> 新建模型来源
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className={styles.panelHeader}>
                <div className={styles.panelTitle}>
                  <strong>{panelMode === 'edit' ? '编辑模型来源' : '新建模型来源'}</strong>
                  <span>推荐直接填写服务根路径，例如 `https://api.deepseek.com` 或 `https://your-gateway/v1`。</span>
                </div>
                <div className={styles.badgeRow}>
                  {draft.isDefault && (
                    <span className={`${styles.softBadge} ${styles.defaultBadge}`}>
                      <Icons.Check size={12} /> 当前将作为 AI Chat 默认模型
                    </span>
                  )}
                  {draft.defaultModelId && <span className={styles.softBadge}>默认 Model: {draft.defaultModelId}</span>}
                </div>
              </div>

              <div className={styles.panelBody}>
                {detailLoading ? (
                  <div className={styles.emptyState} style={{ padding: '120px 0' }}>
                    <Icons.Activity size={32} className="spin" />
                    <span style={{ marginTop: 16 }}>正在读取模型配置详情...</span>
                  </div>
                ) : (
                  <>
            <div className={styles.formGrid}>
              <label className={styles.formSpan2}>
                <div className="form-label">模型名称</div>
                <input
                  className="form-input"
                  placeholder="例如：DeepSeek 官方 / 公司统一网关"
                  value={draft.name}
                  onChange={(e) => updateDraft('name', e.target.value)}
                />
              </label>

              <label className={styles.formSpan2}>
                <div className="form-label">Base URL</div>
                <input
                  className="form-input"
                  placeholder="https://api.deepseek.com 或 https://your-openai-proxy/v1"
                  value={draft.baseUrl}
                  onChange={(e) => updateDraft('baseUrl', e.target.value)}
                />
                <div className={styles.inlineHint} style={{ marginTop: 8 }}>
                  AI Chat 实际请求地址：{endpointPreview || '等待填写 Base URL'}
                </div>
              </label>
            </div>

            <div className={styles.sectionCard}>
              <div className={styles.sectionTitle}>
                <div>
                  <strong>鉴权方式</strong>
                  <span>暂按 OpenAI 兼容格式调用，支持不鉴权、Bearer Token 和自定义 Header。</span>
                </div>
              </div>

              <div className={styles.segmented}>
                {([
                  ['none', '无需鉴权'],
                  ['bearer', 'Bearer Token'],
                  ['custom-header', '自定义 Header'],
                ] as Array<[AIModelAuthType, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={draft.authType === value ? styles.active : ''}
                    onClick={() => updateDraft('authType', value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {draft.authType === 'bearer' && (
                <div className={styles.tokenRow} style={{ marginTop: 14 }}>
                  <input
                    className="form-input"
                    type="password"
                    placeholder="sk-..."
                    value={draft.authToken}
                    onChange={(e) => updateDraft('authToken', e.target.value)}
                  />
                </div>
              )}

              {draft.authType === 'custom-header' && (
                <div className={styles.tokenRow} style={{ marginTop: 14 }}>
                  <input
                    className="form-input"
                    placeholder="Header 名称，例如 api-key"
                    value={draft.authHeaderName}
                    onChange={(e) => updateDraft('authHeaderName', e.target.value)}
                  />
                  <input
                    className="form-input"
                    type="password"
                    placeholder="Header 值"
                    value={draft.authToken}
                    onChange={(e) => updateDraft('authToken', e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className={styles.sectionCard}>
              <div className={styles.sectionTitle}>
                <div>
                  <strong>Model ID 列表</strong>
                  <span>一个 Base URL 可以挂多个模型，AI Chat 页顶部可直接切换。</span>
                </div>
              </div>

              <div className={styles.modelInputRow}>
                <input
                  className="form-input"
                  placeholder="例如：deepseek-chat / gpt-4o-mini / qwen-plus"
                  value={modelIdInput}
                  onChange={(e) => setModelIdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !addingModelId) {
                      e.preventDefault();
                      void addModelId();
                    }
                  }}
                />
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void addModelId()}
                  disabled={addingModelId || !modelIdInput.trim()}
                >
                  <Icons.Plus size={14} /> 添加 Model ID
                  {addingModelId ? '（验证中...）' : ''}
                </button>
              </div>
              <div className={styles.inlineHint} style={{ marginTop: 8 }}>
                新增 Model ID 会先发起一次真实可用性校验；校验失败时，不会加入列表。
              </div>

              {draft.modelIds.length > 0 ? (
                <div className={styles.modelTagWrap}>
                  {draft.modelIds.map((modelId) => (
                    <span key={modelId} className={styles.modelTag}>
                      {modelId}
                      <button type="button" onClick={() => removeModelId(modelId)} title="移除">
                        <Icons.X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <div className={styles.inlineHint} style={{ marginTop: 14 }}>
                  还没有 Model ID。至少添加一个后才能保存，并作为 AI Chat 的候选模型使用。
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <div className="form-label">该来源默认使用的 Model ID</div>
                <select
                  className="form-select"
                  value={draft.defaultModelId}
                  onChange={(e) => updateDraft('defaultModelId', e.target.value)}
                  disabled={draft.modelIds.length === 0}
                >
                  <option value="">-- 请选择默认 Model ID --</option>
                  {draft.modelIds.map((modelId) => (
                    <option key={modelId} value={modelId}>{modelId}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.switchRow}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>设为 AI Chat 默认模型来源</div>
                <div className={styles.inlineHint}>开启后，点击工作流中的 AI Chat 会优先使用这里选择的默认 Model ID。</div>
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(e) => updateDraft('isDefault', e.target.checked)}
                />
                设为默认
              </label>
            </div>

            <div className={styles.footerActions}>
              <div className={styles.footerMainActions}>
                <button className="btn btn-primary" type="button" onClick={handleSave} disabled={saving || addingModelId}>
                  <Icons.Check size={16} />
                  {saving ? '保存中...' : (panelMode === 'edit' ? '保存更新' : '创建模型配置')}
                </button>
                <button className="btn btn-secondary" type="button" onClick={() => unsavedGuard.confirmAction(() => resetEditorState('overview'))}>
                  <Icons.ChevronRight size={16} /> 返回概览
                </button>
              </div>

              {panelMode === 'edit' && activeId && (
                <button className="btn btn-danger-ghost" type="button" onClick={handleDelete}>
                  <Icons.Trash size={16} /> 删除当前配置
                </button>
              )}
            </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {toast && <div className={`${styles.toast} ${toast.type === 'error' ? styles.error : ''}`}>{toast.message}</div>}

      <UnsavedChangesDialog
        open={unsavedGuard.dialogOpen}
        saving={unsavedGuard.saving}
        onCancel={unsavedGuard.closeDialog}
        onDiscard={() => void unsavedGuard.handleDiscard()}
        onSaveAndContinue={() => void unsavedGuard.handleSaveAndContinue()}
      />
    </div>
  );
}
