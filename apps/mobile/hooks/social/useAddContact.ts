/**
 * useAddContact - Add new contact with validation
 * @module hooks/social/useAddContact
 */

import { useState, useCallback, useMemo } from 'react';
import { Contact, useContacts } from './useContacts';
import { useNetwork } from '../common/useNetwork';

export interface AddContactFormData {
  name: string;
  address: string;
  ensName?: string;
  stealthMetaAddress?: string;
  avatar?: string;
  tags?: string[];
  notes?: string;
  isFavorite?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  errors: {
    name?: string;
    address?: string;
    ensName?: string;
    stealthMetaAddress?: string;
  };
}

export type AddContactStep =
  | 'idle'
  | 'validating'
  | 'resolving_ens'
  | 'checking_duplicate'
  | 'saving'
  | 'completed'
  | 'failed';

interface UseAddContactReturn {
  step: AddContactStep;
  isLoading: boolean;
  error: Error | null;
  validationResult: ValidationResult | null;
  resolvedAddress: string | null;
  resolvedEnsName: string | null;
  validate: (data: AddContactFormData) => ValidationResult;
  resolveAddress: (addressOrEns: string) => Promise<string | null>;
  lookupEns: (address: string) => Promise<string | null>;
  addContact: (data: AddContactFormData) => Promise<Contact | null>;
  reset: () => void;
}

// Validation regex patterns
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const ENS_REGEX = /^[a-zA-Z0-9-]+\.eth$/;
const STEALTH_META_REGEX = /^st:eth:0x[a-fA-F0-9]+$/;

export function useAddContact(): UseAddContactReturn {
  const [step, setStep] = useState<AddContactStep>('idle');
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [resolvedEnsName, setResolvedEnsName] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const { addContact: addContactToList, getContactByAddress } = useContacts();
  const { isConnected, provider } = useNetwork();

  const isLoading = useMemo(() => {
    return !['idle', 'completed', 'failed'].includes(step);
  }, [step]);

  const validate = useCallback((data: AddContactFormData): ValidationResult => {
    const errors: ValidationResult['errors'] = {};

    // Validate name
    if (!data.name || data.name.trim().length === 0) {
      errors.name = 'Name is required';
    } else if (data.name.length > 50) {
      errors.name = 'Name must be 50 characters or less';
    }

    // Validate address
    if (!data.address || data.address.trim().length === 0) {
      errors.address = 'Address is required';
    } else if (!ETH_ADDRESS_REGEX.test(data.address) && !ENS_REGEX.test(data.address)) {
      errors.address = 'Invalid Ethereum address or ENS name';
    }

    // Validate ENS name if provided separately
    if (data.ensName && !ENS_REGEX.test(data.ensName)) {
      errors.ensName = 'Invalid ENS name format';
    }

    // Validate stealth meta-address if provided
    if (data.stealthMetaAddress && !STEALTH_META_REGEX.test(data.stealthMetaAddress)) {
      errors.stealthMetaAddress = 'Invalid stealth meta-address format';
    }

    const result: ValidationResult = {
      isValid: Object.keys(errors).length === 0,
      errors,
    };

    setValidationResult(result);
    return result;
  }, []);

  const resolveAddress = useCallback(async (
    addressOrEns: string
  ): Promise<string | null> => {
    setStep('resolving_ens');
    setError(null);

    try {
      // If already an address, return it
      if (ETH_ADDRESS_REGEX.test(addressOrEns)) {
        setResolvedAddress(addressOrEns);
        setStep('idle');
        return addressOrEns;
      }

      // If ENS name, resolve it
      if (ENS_REGEX.test(addressOrEns)) {
        if (!isConnected) {
          throw new Error('Not connected to network');
        }

        // In real implementation: const resolved = await provider.resolveName(addressOrEns);
        // Placeholder
        const resolved = '0x' + '1'.repeat(40);

        if (!resolved) {
          throw new Error('Could not resolve ENS name');
        }

        setResolvedAddress(resolved);
        setResolvedEnsName(addressOrEns);
        setStep('idle');
        return resolved;
      }

      throw new Error('Invalid address format');
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to resolve address'));
      setStep('failed');
      return null;
    }
  }, [isConnected, provider]);

  const lookupEns = useCallback(async (
    address: string
  ): Promise<string | null> => {
    if (!ETH_ADDRESS_REGEX.test(address)) {
      return null;
    }

    try {
      if (!isConnected) {
        return null;
      }

      // In real implementation: const ensName = await provider.lookupAddress(address);
      // Placeholder - return null to indicate no ENS found
      return null;
    } catch {
      return null;
    }
  }, [isConnected, provider]);

  const addContact = useCallback(async (
    data: AddContactFormData
  ): Promise<Contact | null> => {
    setError(null);

    try {
      // Step 1: Validate
      setStep('validating');
      const validation = validate(data);
      if (!validation.isValid) {
        setStep('failed');
        return null;
      }

      // Step 2: Resolve address if ENS
      setStep('resolving_ens');
      let address = data.address;
      let ensName = data.ensName;

      if (ENS_REGEX.test(data.address)) {
        const resolved = await resolveAddress(data.address);
        if (!resolved) {
          return null;
        }
        address = resolved;
        ensName = ensName ?? data.address;
      } else {
        // Try to lookup ENS for the address
        const lookedUpEns = await lookupEns(data.address);
        if (lookedUpEns) {
          ensName = lookedUpEns;
        }
      }

      // Step 3: Check for duplicates
      setStep('checking_duplicate');
      const existing = getContactByAddress(address);
      if (existing) {
        setError(new Error('A contact with this address already exists'));
        setStep('failed');
        return null;
      }

      // Step 4: Save contact
      setStep('saving');

      const contact = await addContactToList({
        name: data.name.trim(),
        address,
        ensName,
        stealthMetaAddress: data.stealthMetaAddress,
        avatar: data.avatar,
        tags: data.tags ?? [],
        notes: data.notes,
        isFavorite: data.isFavorite ?? false,
      });

      if (!contact) {
        setStep('failed');
        return null;
      }

      setStep('completed');
      return contact;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to add contact'));
      setStep('failed');
      return null;
    }
  }, [validate, resolveAddress, lookupEns, getContactByAddress, addContactToList]);

  const reset = useCallback(() => {
    setStep('idle');
    setValidationResult(null);
    setResolvedAddress(null);
    setResolvedEnsName(null);
    setError(null);
  }, []);

  return {
    step,
    isLoading,
    error,
    validationResult,
    resolvedAddress,
    resolvedEnsName,
    validate,
    resolveAddress,
    lookupEns,
    addContact,
    reset,
  };
}

// Utility function to create a contact from transaction
export function createContactFromTransaction(
  transaction: { from: string; to: string },
  direction: 'sent' | 'received',
  myAddress: string
): Partial<AddContactFormData> {
  const contactAddress = direction === 'sent' ? transaction.to : transaction.from;

  return {
    name: '', // User needs to fill this in
    address: contactAddress,
  };
}

// Utility function to validate stealth meta-address
export function validateStealthMetaAddress(metaAddress: string): boolean {
  return STEALTH_META_REGEX.test(metaAddress);
}

// Utility function to format address for display
export function formatAddressForDisplay(
  address: string,
  ensName?: string
): string {
  if (ensName) {
    return ensName;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
