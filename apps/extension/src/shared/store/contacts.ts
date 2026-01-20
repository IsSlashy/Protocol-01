/**
 * Contacts Store for P-01 Wallet Social Feature
 *
 * Handles:
 * - Contact management (add, remove, update)
 * - Friend requests
 * - Block list
 * - Contact nicknames
 * - Encryption key storage for contacts
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../storage';
import { generateId } from '../utils';

// ============ Types ============

export type ContactStatus =
  | 'pending_sent' // We sent a request, waiting for them
  | 'pending_received' // They sent a request, waiting for us
  | 'accepted' // Mutual connection
  | 'blocked'; // We blocked them

export interface Contact {
  /** Unique contact ID */
  id: string;
  /** Wallet address (Solana public key) */
  walletAddress: string;
  /** User-defined nickname */
  nickname?: string;
  /** Contact's encryption public key (base64) */
  encryptionPublicKey?: string;
  /** Relationship status */
  status: ContactStatus;
  /** When the contact was added */
  createdAt: number;
  /** Last interaction timestamp */
  lastInteraction?: number;
  /** Notes about the contact */
  notes?: string;
  /** Avatar seed for generating consistent avatars */
  avatarSeed?: string;
  /** Whether this contact is a favorite */
  isFavorite: boolean;
}

export interface FriendRequest {
  /** Request ID */
  id: string;
  /** Wallet address of the requester */
  fromAddress: string;
  /** Requester's encryption public key */
  encryptionPublicKey: string;
  /** When the request was received */
  receivedAt: number;
  /** Optional message with the request */
  message?: string;
}

interface ContactsStoreState {
  // Data
  contacts: Record<string, Contact>; // walletAddress -> Contact
  blockedAddresses: Set<string>;
  pendingRequests: FriendRequest[];

  // Loading state
  isLoading: boolean;

  // Contact actions
  addContact: (
    walletAddress: string,
    encryptionPublicKey?: string,
    nickname?: string
  ) => Contact;
  removeContact: (walletAddress: string) => void;
  updateContact: (
    walletAddress: string,
    updates: Partial<
      Pick<Contact, 'nickname' | 'notes' | 'isFavorite' | 'encryptionPublicKey'>
    >
  ) => void;
  setContactNickname: (walletAddress: string, nickname: string) => void;
  toggleFavorite: (walletAddress: string) => void;

  // Status actions
  acceptContact: (walletAddress: string) => void;
  rejectContact: (walletAddress: string) => void;
  blockContact: (walletAddress: string) => void;
  unblockContact: (walletAddress: string) => void;

  // Friend request actions
  sendFriendRequest: (
    walletAddress: string,
    encryptionPublicKey?: string
  ) => Contact;
  receiveFriendRequest: (request: FriendRequest) => void;
  acceptFriendRequest: (requestId: string) => Contact | null;
  rejectFriendRequest: (requestId: string) => void;

  // Queries
  getContact: (walletAddress: string) => Contact | undefined;
  getContactByNickname: (nickname: string) => Contact | undefined;
  getAcceptedContacts: () => Contact[];
  getPendingContacts: () => Contact[];
  getSentRequests: () => Contact[];
  getReceivedRequests: () => FriendRequest[];
  getFavorites: () => Contact[];
  isBlocked: (walletAddress: string) => boolean;
  searchContacts: (query: string) => Contact[];

  // Utility
  updateLastInteraction: (walletAddress: string) => void;
  clearAllData: () => void;
  reset: () => void;
}

// Helper to generate avatar seed from wallet address
function generateAvatarSeed(walletAddress: string): string {
  // Use first 8 chars of wallet address as seed for consistent avatar
  return walletAddress.slice(0, 8);
}

// Initial state
const initialState = {
  contacts: {} as Record<string, Contact>,
  blockedAddresses: new Set<string>(),
  pendingRequests: [] as FriendRequest[],
  isLoading: false,
};

export const useContactsStore = create<ContactsStoreState>()(
  persist(
    (set, get) => ({
      ...initialState,

      // Add a new contact
      addContact: (
        walletAddress: string,
        encryptionPublicKey?: string,
        nickname?: string
      ) => {
        const existing = get().contacts[walletAddress];
        if (existing) {
          // Update encryption key if provided
          if (encryptionPublicKey && !existing.encryptionPublicKey) {
            get().updateContact(walletAddress, { encryptionPublicKey });
          }
          return existing;
        }

        const now = Date.now();
        const contact: Contact = {
          id: generateId(),
          walletAddress,
          nickname,
          encryptionPublicKey,
          status: 'accepted',
          createdAt: now,
          avatarSeed: generateAvatarSeed(walletAddress),
          isFavorite: false,
        };

        set((state) => ({
          contacts: {
            ...state.contacts,
            [walletAddress]: contact,
          },
        }));

        return contact;
      },

      // Remove a contact
      removeContact: (walletAddress: string) => {
        set((state) => {
          const { [walletAddress]: _, ...rest } = state.contacts;
          return { contacts: rest };
        });
      },

      // Update contact fields
      updateContact: (walletAddress: string, updates) => {
        set((state) => {
          const contact = state.contacts[walletAddress];
          if (!contact) return state;

          return {
            contacts: {
              ...state.contacts,
              [walletAddress]: { ...contact, ...updates },
            },
          };
        });
      },

      // Set contact nickname
      setContactNickname: (walletAddress: string, nickname: string) => {
        get().updateContact(walletAddress, { nickname: nickname.trim() || undefined });
      },

      // Toggle favorite status
      toggleFavorite: (walletAddress: string) => {
        const contact = get().contacts[walletAddress];
        if (contact) {
          get().updateContact(walletAddress, { isFavorite: !contact.isFavorite });
        }
      },

      // Accept a pending contact
      acceptContact: (walletAddress: string) => {
        set((state) => {
          const contact = state.contacts[walletAddress];
          if (!contact || contact.status !== 'pending_received') return state;

          return {
            contacts: {
              ...state.contacts,
              [walletAddress]: {
                ...contact,
                status: 'accepted',
              },
            },
          };
        });
      },

      // Reject a pending contact
      rejectContact: (walletAddress: string) => {
        get().removeContact(walletAddress);
      },

      // Block a contact
      blockContact: (walletAddress: string) => {
        set((state) => {
          const newBlocked = new Set(state.blockedAddresses);
          newBlocked.add(walletAddress);

          const contact = state.contacts[walletAddress];
          if (!contact) {
            // Create a blocked contact entry
            return {
              blockedAddresses: newBlocked,
              contacts: {
                ...state.contacts,
                [walletAddress]: {
                  id: generateId(),
                  walletAddress,
                  status: 'blocked' as ContactStatus,
                  createdAt: Date.now(),
                  avatarSeed: generateAvatarSeed(walletAddress),
                  isFavorite: false,
                },
              },
            };
          }

          return {
            blockedAddresses: newBlocked,
            contacts: {
              ...state.contacts,
              [walletAddress]: {
                ...contact,
                status: 'blocked',
                isFavorite: false,
              },
            },
          };
        });
      },

      // Unblock a contact
      unblockContact: (walletAddress: string) => {
        set((state) => {
          const newBlocked = new Set(state.blockedAddresses);
          newBlocked.delete(walletAddress);

          const contact = state.contacts[walletAddress];
          if (!contact) return { blockedAddresses: newBlocked };

          return {
            blockedAddresses: newBlocked,
            contacts: {
              ...state.contacts,
              [walletAddress]: {
                ...contact,
                status: 'accepted',
              },
            },
          };
        });
      },

      // Send a friend request (add as pending_sent)
      sendFriendRequest: (walletAddress: string, encryptionPublicKey?: string) => {
        const existing = get().contacts[walletAddress];

        if (existing) {
          if (existing.status === 'pending_received') {
            // They already sent us a request - auto accept
            get().acceptContact(walletAddress);
            return { ...existing, status: 'accepted' as ContactStatus };
          }
          return existing;
        }

        const now = Date.now();
        const contact: Contact = {
          id: generateId(),
          walletAddress,
          encryptionPublicKey,
          status: 'pending_sent',
          createdAt: now,
          avatarSeed: generateAvatarSeed(walletAddress),
          isFavorite: false,
        };

        set((state) => ({
          contacts: {
            ...state.contacts,
            [walletAddress]: contact,
          },
        }));

        return contact;
      },

      // Receive a friend request
      receiveFriendRequest: (request: FriendRequest) => {
        // Check if blocked
        if (get().blockedAddresses.has(request.fromAddress)) {
          return;
        }

        // Check if we already have this contact
        const existing = get().contacts[request.fromAddress];

        if (existing) {
          if (existing.status === 'pending_sent') {
            // We also sent them a request - auto accept
            set((state) => ({
              contacts: {
                ...state.contacts,
                [request.fromAddress]: {
                  ...existing,
                  status: 'accepted',
                  encryptionPublicKey:
                    request.encryptionPublicKey || existing.encryptionPublicKey,
                },
              },
            }));
          }
          return;
        }

        // Add as pending_received
        const contact: Contact = {
          id: generateId(),
          walletAddress: request.fromAddress,
          encryptionPublicKey: request.encryptionPublicKey,
          status: 'pending_received',
          createdAt: request.receivedAt,
          avatarSeed: generateAvatarSeed(request.fromAddress),
          isFavorite: false,
        };

        set((state) => ({
          contacts: {
            ...state.contacts,
            [request.fromAddress]: contact,
          },
          pendingRequests: [...state.pendingRequests, request],
        }));
      },

      // Accept a friend request
      acceptFriendRequest: (requestId: string) => {
        const request = get().pendingRequests.find((r) => r.id === requestId);
        if (!request) return null;

        const contact = get().contacts[request.fromAddress];
        if (!contact) return null;

        set((state) => ({
          contacts: {
            ...state.contacts,
            [request.fromAddress]: {
              ...contact,
              status: 'accepted',
            },
          },
          pendingRequests: state.pendingRequests.filter((r) => r.id !== requestId),
        }));

        return { ...contact, status: 'accepted' as ContactStatus };
      },

      // Reject a friend request
      rejectFriendRequest: (requestId: string) => {
        const request = get().pendingRequests.find((r) => r.id === requestId);
        if (!request) return;

        set((state) => ({
          pendingRequests: state.pendingRequests.filter((r) => r.id !== requestId),
        }));

        get().removeContact(request.fromAddress);
      },

      // Get a contact by wallet address
      getContact: (walletAddress: string) => {
        return get().contacts[walletAddress];
      },

      // Get a contact by nickname
      getContactByNickname: (nickname: string) => {
        const normalizedNickname = nickname.toLowerCase();
        return Object.values(get().contacts).find(
          (c) => c.nickname?.toLowerCase() === normalizedNickname
        );
      },

      // Get all accepted contacts
      getAcceptedContacts: () => {
        return Object.values(get().contacts)
          .filter((c) => c.status === 'accepted')
          .sort((a, b) => {
            // Favorites first, then by name/address
            if (a.isFavorite && !b.isFavorite) return -1;
            if (!a.isFavorite && b.isFavorite) return 1;
            const nameA = a.nickname || a.walletAddress;
            const nameB = b.nickname || b.walletAddress;
            return nameA.localeCompare(nameB);
          });
      },

      // Get pending contacts (both sent and received)
      getPendingContacts: () => {
        return Object.values(get().contacts).filter(
          (c) => c.status === 'pending_sent' || c.status === 'pending_received'
        );
      },

      // Get contacts where we sent a request
      getSentRequests: () => {
        return Object.values(get().contacts).filter(
          (c) => c.status === 'pending_sent'
        );
      },

      // Get pending friend requests (received)
      getReceivedRequests: () => {
        return get().pendingRequests;
      },

      // Get favorite contacts
      getFavorites: () => {
        return Object.values(get().contacts)
          .filter((c) => c.status === 'accepted' && c.isFavorite)
          .sort((a, b) => {
            const nameA = a.nickname || a.walletAddress;
            const nameB = b.nickname || b.walletAddress;
            return nameA.localeCompare(nameB);
          });
      },

      // Check if an address is blocked
      isBlocked: (walletAddress: string) => {
        return get().blockedAddresses.has(walletAddress);
      },

      // Search contacts by nickname or address
      searchContacts: (query: string) => {
        const normalizedQuery = query.toLowerCase();
        return Object.values(get().contacts)
          .filter((c) => c.status === 'accepted')
          .filter(
            (c) =>
              c.nickname?.toLowerCase().includes(normalizedQuery) ||
              c.walletAddress.toLowerCase().includes(normalizedQuery)
          );
      },

      // Update last interaction timestamp
      updateLastInteraction: (walletAddress: string) => {
        set((state) => {
          const contact = state.contacts[walletAddress];
          if (!contact) return state;

          return {
            contacts: {
              ...state.contacts,
              [walletAddress]: {
                ...contact,
                lastInteraction: Date.now(),
              },
            },
          };
        });
      },

      // Clear all data
      clearAllData: () => {
        set({
          contacts: {},
          blockedAddresses: new Set(),
          pendingRequests: [],
        });
      },

      // Reset to initial state
      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'p01-contacts',
      storage: createJSONStorage(() => chromeStorage),
      partialize: (state) => ({
        contacts: state.contacts,
        // Convert Set to Array for JSON serialization
        blockedAddresses: Array.from(state.blockedAddresses),
        pendingRequests: state.pendingRequests,
      }),
      merge: (persistedState: any, currentState: ContactsStoreState) => ({
        ...currentState,
        ...persistedState,
        // Convert Array back to Set
        blockedAddresses: new Set(persistedState?.blockedAddresses || []),
      }),
    }
  )
);

// Selector hooks
export const useAcceptedContacts = () =>
  useContactsStore((state) => state.getAcceptedContacts());
export const usePendingContacts = () =>
  useContactsStore((state) => state.getPendingContacts());
export const useContact = (walletAddress: string) =>
  useContactsStore((state) => state.contacts[walletAddress]);
export const useFavoriteContacts = () =>
  useContactsStore((state) => state.getFavorites());
