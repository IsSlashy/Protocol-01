/**
 * Global Alert Store — drives the styled AlertModal from anywhere.
 *
 * Usage:  import { p01Alert } from '@/stores/alertStore';
 *         p01Alert('Title', 'Message', [{ text: 'OK' }], 'success');
 *
 * Drop-in replacement for Alert.alert() with P01 cyber styling.
 */

import { create } from 'zustand';

export interface AlertButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

type AlertIcon = 'warning' | 'error' | 'success' | 'info' | 'question';

interface AlertState {
  visible: boolean;
  title: string;
  message: string;
  buttons: AlertButton[];
  icon?: AlertIcon;
  dismiss: () => void;
  show: (title: string, message?: string, buttons?: AlertButton[], icon?: AlertIcon) => void;
}

export const useAlertStore = create<AlertState>((set) => ({
  visible: false,
  title: '',
  message: '',
  buttons: [{ text: 'OK', style: 'default' }],
  icon: undefined,
  dismiss: () => set({ visible: false }),
  show: (title, message = '', buttons, icon) => {
    // Auto-detect icon from title if not explicitly provided
    const autoIcon = icon ?? detectIcon(title);
    set({
      visible: true,
      title,
      message,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK', style: 'default' }],
      icon: autoIcon,
    });
  },
}));

function detectIcon(title: string): AlertIcon | undefined {
  const t = title.toLowerCase();
  if (t.includes('error') || t.includes('failed') || t.includes('invalid') || t.includes('insufficient')) return 'error';
  if (t.includes('success') || t.includes('done') || t.includes('complete') || t.includes('copied') || t.includes('updated') || t.includes('recovered')) return 'success';
  if (t.includes('warning') || t.includes('weak') || t.includes('mismatch')) return 'warning';
  if (t.includes('confirm') || t.includes('disconnect') || t.includes('delete') || t.includes('cancel') || t.includes('reset') || t.includes('clear')) return 'question';
  return 'info';
}

/**
 * Drop-in replacement for Alert.alert() with P01 styled modal.
 *
 * p01Alert('Title', 'Message');
 * p01Alert('Success', 'Done!', [{ text: 'OK' }], 'success');
 */
export function p01Alert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
  icon?: AlertIcon,
): void {
  useAlertStore.getState().show(title, message, buttons, icon);
}
