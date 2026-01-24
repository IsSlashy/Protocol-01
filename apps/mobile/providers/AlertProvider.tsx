/**
 * AlertProvider - Global alert context to replace Alert.alert
 *
 * Usage:
 *   const { showAlert, showConfirm } = useAlert();
 *
 *   showAlert('Title', 'Message');
 *   showConfirm('Delete?', 'Are you sure?', { onConfirm: () => {...} });
 */

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { AlertModal, AlertButton, AlertModalProps } from '../components/ui/AlertModal';

interface AlertConfig extends Omit<AlertModalProps, 'visible' | 'onDismiss'> {}

interface ConfirmOptions {
  confirmText?: string;
  cancelText?: string;
  confirmStyle?: 'default' | 'destructive';
  icon?: AlertModalProps['icon'];
  onConfirm?: () => void;
  onCancel?: () => void;
}

interface AlertContextType {
  /**
   * Show a simple alert with OK button
   */
  showAlert: (
    title: string,
    message?: string,
    options?: {
      icon?: AlertModalProps['icon'];
      buttonText?: string;
      onDismiss?: () => void;
    }
  ) => void;

  /**
   * Show a confirmation dialog with confirm/cancel buttons
   */
  showConfirm: (
    title: string,
    message?: string,
    options?: ConfirmOptions
  ) => void;

  /**
   * Show a custom alert with full control over buttons
   */
  showCustom: (config: AlertConfig) => void;

  /**
   * Dismiss the current alert
   */
  dismiss: () => void;
}

const AlertContext = createContext<AlertContextType | null>(null);

interface AlertProviderProps {
  children: ReactNode;
}

export function AlertProvider({ children }: AlertProviderProps) {
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<AlertConfig>({
    title: '',
  });

  const dismiss = useCallback(() => {
    setVisible(false);
  }, []);

  const showAlert = useCallback((
    title: string,
    message?: string,
    options?: {
      icon?: AlertModalProps['icon'];
      buttonText?: string;
      onDismiss?: () => void;
    }
  ) => {
    setConfig({
      title,
      message,
      icon: options?.icon,
      buttons: [{
        text: options?.buttonText || 'OK',
        style: 'default',
        onPress: options?.onDismiss,
      }],
    });
    setVisible(true);
  }, []);

  const showConfirm = useCallback((
    title: string,
    message?: string,
    options?: ConfirmOptions
  ) => {
    const buttons: AlertButton[] = [
      {
        text: options?.confirmText || 'Confirm',
        style: options?.confirmStyle || 'default',
        onPress: options?.onConfirm,
      },
      {
        text: options?.cancelText || 'Cancel',
        style: 'cancel',
        onPress: options?.onCancel,
      },
    ];

    setConfig({
      title,
      message,
      icon: options?.icon || 'question',
      buttons,
    });
    setVisible(true);
  }, []);

  const showCustom = useCallback((alertConfig: AlertConfig) => {
    setConfig(alertConfig);
    setVisible(true);
  }, []);

  const contextValue: AlertContextType = {
    showAlert,
    showConfirm,
    showCustom,
    dismiss,
  };

  return (
    <AlertContext.Provider value={contextValue}>
      {children}
      <AlertModal
        visible={visible}
        onDismiss={dismiss}
        {...config}
      />
    </AlertContext.Provider>
  );
}

/**
 * Hook to access alert functions
 */
export function useAlert(): AlertContextType {
  const context = useContext(AlertContext);
  if (!context) {
    throw new Error('useAlert must be used within an AlertProvider');
  }
  return context;
}

export default AlertProvider;
