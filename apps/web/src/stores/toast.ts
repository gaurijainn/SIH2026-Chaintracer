import { create } from 'zustand';
import { errorMessage } from '@/lib/api/errors';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Optional in-app link, e.g. "Open case". */
  action?: { label: string; to: string };
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>, ttlMs?: number) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t, ttlMs) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    // errors linger longer so they can be read
    const ttl = ttlMs ?? (t.kind === 'error' ? 8000 : 4500);
    if (ttl > 0) setTimeout(() => get().dismiss(id), ttl);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative API for use outside components (mutation callbacks, query error handlers). */
export const toast = {
  success: (title: string, description?: string) => useToastStore.getState().push({ kind: 'success', title, description }),
  info: (title: string, description?: string) => useToastStore.getState().push({ kind: 'info', title, description }),
  warning: (title: string, description?: string) => useToastStore.getState().push({ kind: 'warning', title, description }),
  /** Accepts a thrown value; ApiError messages are already investigator-safe. */
  error: (title: string, err?: unknown) => useToastStore.getState().push({ kind: 'error', title, description: err === undefined ? undefined : errorMessage(err) }),
};
