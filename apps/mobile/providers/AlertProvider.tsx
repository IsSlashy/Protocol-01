/**
 * AlertProvider — Mounts the global AlertModal driven by useAlertStore.
 *
 * Usage from any file (no hook needed):
 *   import { p01Alert } from '@/stores/alertStore';
 *   p01Alert('Title', 'Message');
 *   p01Alert('Confirm?', 'Are you sure?', [
 *     { text: 'Yes', onPress: () => doIt() },
 *     { text: 'Cancel', style: 'cancel' },
 *   ], 'question');
 */

import React, { type ReactNode } from 'react';
import AlertModal from '../components/ui/AlertModal';

interface AlertProviderProps {
  children: ReactNode;
}

export function AlertProvider({ children }: AlertProviderProps) {
  return (
    <>
      {children}
      <AlertModal />
    </>
  );
}

export default AlertProvider;
