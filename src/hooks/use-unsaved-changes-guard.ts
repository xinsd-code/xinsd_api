'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseUnsavedChangesGuardOptions {
  enabled?: boolean;
  isDirty: boolean;
  onSave?: () => Promise<boolean> | boolean;
}

type PendingAction = (() => void | Promise<void>) | null;

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function isDescendantNavigation(currentUrl: URL, nextUrl: URL): boolean {
  const currentPath = normalizePathname(currentUrl.pathname);
  const nextPath = normalizePathname(nextUrl.pathname);

  if (currentPath === '/' || nextPath === currentPath) {
    return false;
  }

  return nextPath.startsWith(`${currentPath}/`);
}

export function useUnsavedChangesGuard({
  enabled = true,
  isDirty,
  onSave,
}: UseUnsavedChangesGuardOptions) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingActionRef = useRef<PendingAction>(null);
  const isDirtyRef = useRef(isDirty);
  const enabledRef = useRef(enabled);
  const onSaveRef = useRef(onSave);
  const bypassPopstateRef = useRef(false);
  const guardStateActiveRef = useRef(false);
  const suppressBeforeUnloadRef = useRef(false);
  const suppressBeforeUnloadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isDirtyRef.current = isDirty;
    enabledRef.current = enabled;
    onSaveRef.current = onSave;
  }, [enabled, isDirty, onSave]);

  useEffect(() => {
    if (dialogOpen && !(enabled && isDirty)) {
      pendingActionRef.current = null;
      setDialogOpen(false);
    }
  }, [dialogOpen, enabled, isDirty]);

  const runPendingAction = useCallback(async () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!action) return;
    await action();
  }, []);

  const closeDialog = useCallback(() => {
    if (saving) return;
    pendingActionRef.current = null;
    setDialogOpen(false);
  }, [saving]);

  const confirmAction = useCallback((action: () => void | Promise<void>) => {
    if (!(enabledRef.current && isDirtyRef.current)) {
      void action();
      return;
    }

    pendingActionRef.current = action;
    setDialogOpen(true);
  }, []);

  const confirmNavigation = useCallback((href: string, action: () => void | Promise<void>) => {
    const currentUrl = new URL(window.location.href);
    const nextUrl = new URL(href, currentUrl.href);

    if (nextUrl.origin === currentUrl.origin && isDescendantNavigation(currentUrl, nextUrl)) {
      suppressBeforeUnloadRef.current = true;
      if (suppressBeforeUnloadTimerRef.current !== null) {
        window.clearTimeout(suppressBeforeUnloadTimerRef.current);
      }
      suppressBeforeUnloadTimerRef.current = window.setTimeout(() => {
        suppressBeforeUnloadRef.current = false;
        suppressBeforeUnloadTimerRef.current = null;
      }, 1200);
      void action();
      return;
    }

    confirmAction(action);
  }, [confirmAction]);

  const handleDiscard = useCallback(async () => {
    setDialogOpen(false);
    suppressBeforeUnloadRef.current = true;
    if (suppressBeforeUnloadTimerRef.current !== null) {
      window.clearTimeout(suppressBeforeUnloadTimerRef.current);
    }
    suppressBeforeUnloadTimerRef.current = window.setTimeout(() => {
      suppressBeforeUnloadRef.current = false;
      suppressBeforeUnloadTimerRef.current = null;
    }, 1200);
    await runPendingAction();
  }, [runPendingAction]);

  const handleSaveAndContinue = useCallback(async () => {
    if (!onSaveRef.current) {
      setDialogOpen(false);
      suppressBeforeUnloadRef.current = true;
      if (suppressBeforeUnloadTimerRef.current !== null) {
        window.clearTimeout(suppressBeforeUnloadTimerRef.current);
      }
      suppressBeforeUnloadTimerRef.current = window.setTimeout(() => {
        suppressBeforeUnloadRef.current = false;
        suppressBeforeUnloadTimerRef.current = null;
      }, 1200);
      await runPendingAction();
      return;
    }

    setSaving(true);
    try {
      const saved = await onSaveRef.current();
      if (!saved) {
        return;
      }
      setDialogOpen(false);
      suppressBeforeUnloadRef.current = true;
      if (suppressBeforeUnloadTimerRef.current !== null) {
        window.clearTimeout(suppressBeforeUnloadTimerRef.current);
      }
      suppressBeforeUnloadTimerRef.current = window.setTimeout(() => {
        suppressBeforeUnloadRef.current = false;
        suppressBeforeUnloadTimerRef.current = null;
      }, 1200);
      await runPendingAction();
    } finally {
      setSaving(false);
    }
  }, [runPendingAction]);

  useEffect(() => {
    if (!(enabled && isDirty)) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (suppressBeforeUnloadRef.current) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [enabled, isDirty]);

  useEffect(() => {
    if (!(enabled && isDirty)) {
      guardStateActiveRef.current = false;
      return;
    }

    if (!guardStateActiveRef.current) {
      window.history.pushState({ __unsavedChangesGuard: true }, '', window.location.href);
      guardStateActiveRef.current = true;
    }

    const handlePopState = () => {
      if (!(enabledRef.current && isDirtyRef.current)) return;
      if (bypassPopstateRef.current) {
        bypassPopstateRef.current = false;
        return;
      }

      window.history.pushState({ __unsavedChangesGuard: true }, '', window.location.href);
      pendingActionRef.current = () => {
        bypassPopstateRef.current = true;
        window.history.back();
      };
      setDialogOpen(true);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [enabled, isDirty]);

  useEffect(() => () => {
    if (suppressBeforeUnloadTimerRef.current !== null) {
      window.clearTimeout(suppressBeforeUnloadTimerRef.current);
    }
  }, []);

  return {
    dialogOpen,
    saving,
    confirmAction,
    confirmNavigation,
    closeDialog,
    handleDiscard,
    handleSaveAndContinue,
  };
}
