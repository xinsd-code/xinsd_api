'use client';

import { Icons } from '@/components/Icons';
import styles from './unsaved-changes-dialog.module.css';

interface UnsavedChangesDialogProps {
  open: boolean;
  saving?: boolean;
  title?: string;
  description?: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndContinue: () => void;
}

export default function UnsavedChangesDialog({
  open,
  saving = false,
  title = '当前页面还有未保存修改',
  description = '如果现在离开，当前新增或编辑中的内容会丢失。你可以先保存，再继续跳转；也可以放弃修改，直接离开。',
  onCancel,
  onDiscard,
  onSaveAndContinue,
}: UnsavedChangesDialogProps) {
  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={saving ? undefined : onCancel}>
      <div className={styles.dialog} onClick={(event) => event.stopPropagation()}>
        <div className={styles.body}>
          <div className={styles.eyebrow}>
            <Icons.AlertTriangle size={14} />
            未保存修改
          </div>
          <div className={styles.title}>{title}</div>
          <div className={styles.desc}>{description}</div>
          <div className={styles.meta}>
            选择“保存后离开”会先执行当前页面的保存逻辑，保存成功后再跳转；如果保存失败，会停留在当前页。
          </div>
        </div>
        <div className={styles.footer}>
          <button className={`btn btn-secondary ${styles.ghostBtn}`} type="button" onClick={onCancel} disabled={saving}>
            继续编辑
          </button>
          <button className={`btn btn-danger-ghost ${styles.dangerBtn}`} type="button" onClick={onDiscard} disabled={saving}>
            不保存直接离开
          </button>
          <button className="btn btn-primary" type="button" onClick={onSaveAndContinue} disabled={saving}>
            <Icons.Check size={16} />
            {saving ? '保存中...' : '保存后离开'}
          </button>
        </div>
      </div>
    </div>
  );
}
