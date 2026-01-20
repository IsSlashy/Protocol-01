/**
 * ConversationList Component
 * Displays list of conversations with contacts
 */

import { AnimatePresence } from 'framer-motion';
import { MessageCircle, UserPlus, Users, Search, Loader2 } from 'lucide-react';
import { Conversation } from '@/shared/store/messages';
import { Contact } from '@/shared/store/contacts';
import ContactCard from './ContactCard';

interface ConversationListProps {
  conversations: Conversation[];
  contacts: Record<string, Contact>;
  pendingRequestCount: number;
  myWalletAddress: string;
  searchQuery: string;
  isLoading?: boolean;
  onSearchChange: (query: string) => void;
  onConversationClick: (conversation: Conversation) => void;
  onAddContactClick: () => void;
  onViewRequestsClick: () => void;
}

export default function ConversationList({
  conversations,
  contacts,
  pendingRequestCount,
  myWalletAddress,
  searchQuery,
  isLoading = false,
  onSearchChange,
  onConversationClick,
  onAddContactClick,
  onViewRequestsClick,
}: ConversationListProps) {
  // Filter conversations based on search
  const filteredConversations = conversations.filter((conv) => {
    if (!searchQuery) return true;

    const contactAddress = conv.participants.find((p) => p !== myWalletAddress);
    if (!contactAddress) return false;

    const contact = contacts[contactAddress];
    const query = searchQuery.toLowerCase();

    return (
      contact?.nickname?.toLowerCase().includes(query) ||
      contactAddress.toLowerCase().includes(query)
    );
  });

  // Get contact for conversation
  const getContactForConversation = (conv: Conversation): Contact | undefined => {
    const contactAddress = conv.participants.find((p) => p !== myWalletAddress);
    return contactAddress ? contacts[contactAddress] : undefined;
  };

  // Format last message time
  const formatMessageTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;

    // Less than 1 minute
    if (diff < 60000) return 'now';

    // Less than 1 hour
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;

    // Less than 24 hours
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;

    // Less than 7 days
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;

    // Older
    return new Date(timestamp).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="flex flex-col h-full bg-p01-void">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border">
        <h1 className="text-white font-display font-bold tracking-wide">Messages</h1>
        <div className="flex items-center gap-2">
          {pendingRequestCount > 0 && (
            <button
              onClick={onViewRequestsClick}
              className="relative p-2 text-p01-chrome hover:text-white transition-colors"
            >
              <Users className="w-5 h-5" />
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-p01-pink text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                {pendingRequestCount > 9 ? '9+' : pendingRequestCount}
              </span>
            </button>
          )}
          <button
            onClick={onAddContactClick}
            className="p-2 text-p01-chrome hover:text-white transition-colors"
          >
            <UserPlus className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Search */}
      <div className="px-4 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-p01-chrome/40" />
          <input
            type="text"
            placeholder="Search contacts..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-p01-surface rounded-xl text-white text-sm placeholder-p01-chrome/40 focus:outline-none focus:ring-1 focus:ring-p01-cyan"
          />
        </div>
      </div>

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-p01-cyan animate-spin mb-4" />
            <p className="text-p01-chrome text-sm">Loading conversations...</p>
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 rounded-full bg-p01-surface flex items-center justify-center mb-4">
              <MessageCircle className="w-8 h-8 text-p01-chrome/40" />
            </div>
            <p className="text-white font-medium mb-1">
              {searchQuery ? 'No results found' : 'No conversations yet'}
            </p>
            <p className="text-p01-chrome text-sm text-center mb-4">
              {searchQuery
                ? 'Try a different search term'
                : 'Add friends by their wallet address to start chatting'}
            </p>
            {!searchQuery && (
              <button
                onClick={onAddContactClick}
                className="px-4 py-2 bg-p01-cyan text-p01-void font-medium rounded-lg text-sm"
              >
                Add Contact
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence mode="popLayout">
              {filteredConversations.map((conversation) => {
                const contact = getContactForConversation(conversation);
                if (!contact) return null;

                return (
                  <ContactCard
                    key={conversation.id}
                    contact={contact}
                    lastMessage={conversation.lastMessage?.content}
                    lastMessageTime={
                      conversation.lastMessage
                        ? formatMessageTime(conversation.lastMessage.timestamp)
                        : undefined
                    }
                    unreadCount={conversation.unreadCount}
                    onClick={() => onConversationClick(conversation)}
                  />
                );
              })}
            </AnimatePresence>
          </div>
        )}

        {/* Pending sent requests section */}
        {Object.values(contacts).filter((c) => c.status === 'pending_sent').length >
          0 && (
          <div className="mt-6">
            <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider px-1">
              PENDING REQUESTS
            </p>
            <div className="space-y-2">
              {Object.values(contacts)
                .filter((c) => c.status === 'pending_sent')
                .map((contact) => (
                  <ContactCard
                    key={contact.id}
                    contact={contact}
                    variant="compact"
                  />
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
