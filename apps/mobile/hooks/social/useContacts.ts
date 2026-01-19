/**
 * useContacts - Manage contact list
 * @module hooks/social/useContacts
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAsyncStorage, ASYNC_KEYS } from '../storage/useAsyncStorage';

export interface Contact {
  id: string;
  name: string;
  address: string;
  ensName?: string;
  stealthMetaAddress?: string;
  avatar?: string;
  createdAt: number;
  lastInteractionAt?: number;
  isFavorite: boolean;
  tags: string[];
  notes?: string;
  // Payment stats
  totalSent: bigint;
  totalReceived: bigint;
  transactionCount: number;
  // E2E Encryption
  encryptionPublicKey?: string;
  publicKeyVerified?: boolean;
}

export interface ContactGroup {
  id: string;
  name: string;
  contactIds: string[];
  color?: string;
}

interface UseContactsOptions {
  searchQuery?: string;
  filterTags?: string[];
  sortBy?: 'name' | 'recent' | 'frequent';
  showFavoritesFirst?: boolean;
}

interface UseContactsReturn {
  contacts: Contact[];
  favorites: Contact[];
  recent: Contact[];
  groups: ContactGroup[];
  isLoading: boolean;
  error: Error | null;
  addContact: (contact: Omit<Contact, 'id' | 'createdAt' | 'totalSent' | 'totalReceived' | 'transactionCount'>) => Promise<Contact | null>;
  updateContact: (id: string, updates: Partial<Contact>) => Promise<boolean>;
  deleteContact: (id: string) => Promise<boolean>;
  toggleFavorite: (id: string) => Promise<boolean>;
  searchContacts: (query: string) => Contact[];
  getContactByAddress: (address: string) => Contact | undefined;
  createGroup: (name: string, color?: string) => Promise<ContactGroup | null>;
  addToGroup: (contactId: string, groupId: string) => Promise<boolean>;
  removeFromGroup: (contactId: string, groupId: string) => Promise<boolean>;
  importContacts: (contacts: Partial<Contact>[]) => Promise<number>;
  exportContacts: () => Contact[];
  refresh: () => Promise<void>;
  // E2E Encryption methods
  updateEncryptionKey: (contactId: string, encryptionPublicKey: string, verified?: boolean) => Promise<boolean>;
  getContactsWithEncryption: () => Contact[];
}

export function useContacts(options: UseContactsOptions = {}): UseContactsReturn {
  const {
    searchQuery = '',
    filterTags = [],
    sortBy = 'name',
    showFavoritesFirst = true,
  } = options;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const {
    value: contacts,
    setValue: setContacts,
    refresh: refreshContacts,
  } = useAsyncStorage<Contact[]>({
    key: ASYNC_KEYS.CONTACTS,
    defaultValue: [],
  });

  const {
    value: groups,
    setValue: setGroups,
  } = useAsyncStorage<ContactGroup[]>({
    key: `${ASYNC_KEYS.CONTACTS}_groups`,
    defaultValue: [],
  });

  const contactList = contacts ?? [];
  const groupList = groups ?? [];

  // Apply filters and sorting
  const filteredContacts = useMemo(() => {
    let result = [...contactList];

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        c =>
          c.name.toLowerCase().includes(query) ||
          c.address.toLowerCase().includes(query) ||
          c.ensName?.toLowerCase().includes(query) ||
          c.tags.some(t => t.toLowerCase().includes(query))
      );
    }

    // Apply tag filter
    if (filterTags.length > 0) {
      result = result.filter(c =>
        filterTags.some(tag => c.tags.includes(tag))
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      // Favorites first if enabled
      if (showFavoritesFirst && a.isFavorite !== b.isFavorite) {
        return a.isFavorite ? -1 : 1;
      }

      switch (sortBy) {
        case 'recent':
          return (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0);
        case 'frequent':
          return b.transactionCount - a.transactionCount;
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });

    return result;
  }, [contactList, searchQuery, filterTags, sortBy, showFavoritesFirst]);

  // Derived lists
  const favorites = useMemo(
    () => contactList.filter(c => c.isFavorite),
    [contactList]
  );

  const recent = useMemo(
    () => [...contactList]
      .filter(c => c.lastInteractionAt)
      .sort((a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0))
      .slice(0, 10),
    [contactList]
  );

  useEffect(() => {
    setIsLoading(false);
  }, [contacts]);

  const addContact = useCallback(async (
    contactData: Omit<Contact, 'id' | 'createdAt' | 'totalSent' | 'totalReceived' | 'transactionCount'>
  ): Promise<Contact | null> => {
    try {
      // Check for duplicate address
      const existing = contactList.find(
        c => c.address.toLowerCase() === contactData.address.toLowerCase()
      );
      if (existing) {
        setError(new Error('Contact with this address already exists'));
        return null;
      }

      const newContact: Contact = {
        ...contactData,
        id: generateId(),
        createdAt: Date.now(),
        totalSent: BigInt(0),
        totalReceived: BigInt(0),
        transactionCount: 0,
      };

      const updatedContacts = [...contactList, newContact];
      await setContacts(updatedContacts);

      return newContact;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to add contact'));
      return null;
    }
  }, [contactList, setContacts]);

  const updateContact = useCallback(async (
    id: string,
    updates: Partial<Contact>
  ): Promise<boolean> => {
    try {
      const index = contactList.findIndex(c => c.id === id);
      if (index === -1) {
        setError(new Error('Contact not found'));
        return false;
      }

      const updatedContacts = [...contactList];
      updatedContacts[index] = { ...updatedContacts[index], ...updates };

      await setContacts(updatedContacts);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to update contact'));
      return false;
    }
  }, [contactList, setContacts]);

  const deleteContact = useCallback(async (id: string): Promise<boolean> => {
    try {
      const updatedContacts = contactList.filter(c => c.id !== id);
      await setContacts(updatedContacts);

      // Remove from all groups
      const updatedGroups = groupList.map(g => ({
        ...g,
        contactIds: g.contactIds.filter(cId => cId !== id),
      }));
      await setGroups(updatedGroups);

      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to delete contact'));
      return false;
    }
  }, [contactList, groupList, setContacts, setGroups]);

  const toggleFavorite = useCallback(async (id: string): Promise<boolean> => {
    const contact = contactList.find(c => c.id === id);
    if (!contact) return false;

    return updateContact(id, { isFavorite: !contact.isFavorite });
  }, [contactList, updateContact]);

  const searchContacts = useCallback((query: string): Contact[] => {
    if (!query) return contactList;

    const lowerQuery = query.toLowerCase();
    return contactList.filter(
      c =>
        c.name.toLowerCase().includes(lowerQuery) ||
        c.address.toLowerCase().includes(lowerQuery) ||
        c.ensName?.toLowerCase().includes(lowerQuery)
    );
  }, [contactList]);

  const getContactByAddress = useCallback((address: string): Contact | undefined => {
    return contactList.find(
      c => c.address.toLowerCase() === address.toLowerCase()
    );
  }, [contactList]);

  const createGroup = useCallback(async (
    name: string,
    color?: string
  ): Promise<ContactGroup | null> => {
    try {
      const newGroup: ContactGroup = {
        id: generateId(),
        name,
        contactIds: [],
        color,
      };

      await setGroups([...groupList, newGroup]);
      return newGroup;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to create group'));
      return null;
    }
  }, [groupList, setGroups]);

  const addToGroup = useCallback(async (
    contactId: string,
    groupId: string
  ): Promise<boolean> => {
    try {
      const groupIndex = groupList.findIndex(g => g.id === groupId);
      if (groupIndex === -1) return false;

      const group = groupList[groupIndex];
      if (group.contactIds.includes(contactId)) return true;

      const updatedGroups = [...groupList];
      updatedGroups[groupIndex] = {
        ...group,
        contactIds: [...group.contactIds, contactId],
      };

      await setGroups(updatedGroups);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to add to group'));
      return false;
    }
  }, [groupList, setGroups]);

  const removeFromGroup = useCallback(async (
    contactId: string,
    groupId: string
  ): Promise<boolean> => {
    try {
      const groupIndex = groupList.findIndex(g => g.id === groupId);
      if (groupIndex === -1) return false;

      const updatedGroups = [...groupList];
      updatedGroups[groupIndex] = {
        ...updatedGroups[groupIndex],
        contactIds: updatedGroups[groupIndex].contactIds.filter(id => id !== contactId),
      };

      await setGroups(updatedGroups);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to remove from group'));
      return false;
    }
  }, [groupList, setGroups]);

  const importContacts = useCallback(async (
    newContacts: Partial<Contact>[]
  ): Promise<number> => {
    try {
      let imported = 0;

      for (const data of newContacts) {
        if (!data.address || !data.name) continue;

        // Skip duplicates
        const exists = contactList.some(
          c => c.address.toLowerCase() === data.address!.toLowerCase()
        );
        if (exists) continue;

        const contact: Contact = {
          id: generateId(),
          name: data.name,
          address: data.address,
          ensName: data.ensName,
          stealthMetaAddress: data.stealthMetaAddress,
          avatar: data.avatar,
          createdAt: Date.now(),
          isFavorite: data.isFavorite ?? false,
          tags: data.tags ?? [],
          notes: data.notes,
          totalSent: BigInt(0),
          totalReceived: BigInt(0),
          transactionCount: 0,
        };

        contactList.push(contact);
        imported++;
      }

      await setContacts([...contactList]);
      return imported;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to import contacts'));
      return 0;
    }
  }, [contactList, setContacts]);

  const exportContacts = useCallback((): Contact[] => {
    return contactList;
  }, [contactList]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await refreshContacts();
    setIsLoading(false);
  }, [refreshContacts]);

  // Update encryption public key for a contact
  const updateEncryptionKey = useCallback(async (
    contactId: string,
    encryptionPublicKey: string,
    verified: boolean = false
  ): Promise<boolean> => {
    try {
      const index = contactList.findIndex(c => c.id === contactId);
      if (index === -1) {
        setError(new Error('Contact not found'));
        return false;
      }

      const updatedContacts = [...contactList];
      updatedContacts[index] = {
        ...updatedContacts[index],
        encryptionPublicKey,
        publicKeyVerified: verified,
      };

      await setContacts(updatedContacts);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to update encryption key'));
      return false;
    }
  }, [contactList, setContacts]);

  // Get contacts that have encryption keys set up
  const getContactsWithEncryption = useCallback((): Contact[] => {
    return contactList.filter(c => !!c.encryptionPublicKey);
  }, [contactList]);

  return {
    contacts: filteredContacts,
    favorites,
    recent,
    groups: groupList,
    isLoading,
    error,
    addContact,
    updateContact,
    deleteContact,
    toggleFavorite,
    searchContacts,
    getContactByAddress,
    createGroup,
    addToGroup,
    removeFromGroup,
    importContacts,
    exportContacts,
    refresh,
    updateEncryptionKey,
    getContactsWithEncryption,
  };
}

// Helper to generate unique IDs
function generateId(): string {
  return `contact_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
