/**
 * ContactCard Component
 * Displays a contact with avatar, name, and status
 */

import { motion } from 'framer-motion';
import { Star, Lock, Clock, Check, X, MoreVertical, User } from 'lucide-react';
import { cn, truncateAddress } from '@/shared/utils';
import { Contact, ContactStatus } from '@/shared/store/contacts';
import { useState } from 'react';

interface ContactCardProps {
  contact: Contact;
  lastMessage?: string;
  lastMessageTime?: string;
  unreadCount?: number;
  onClick?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  onToggleFavorite?: () => void;
  showActions?: boolean;
  variant?: 'default' | 'compact' | 'request';
}

// Generate a deterministic gradient from wallet address
function getAvatarGradient(seed: string): string {
  const gradients = [
    'from-p01-pink to-purple-600',
    'from-violet-500 to-purple-600',
    'from-blue-500 to-cyan-500',
    'from-emerald-500 to-teal-500',
    'from-orange-500 to-red-500',
    'from-pink-500 to-rose-500',
    'from-indigo-500 to-blue-500',
    'from-teal-500 to-green-500',
  ];

  // Use first char code to pick a gradient
  const charCode = seed.charCodeAt(0) || 0;
  return gradients[charCode % gradients.length];
}

function getStatusInfo(status: ContactStatus): {
  icon: React.ReactNode;
  text: string;
  color: string;
} {
  switch (status) {
    case 'pending_sent':
      return {
        icon: <Clock className="w-3 h-3" />,
        text: 'Request sent',
        color: 'text-yellow-500',
      };
    case 'pending_received':
      return {
        icon: <User className="w-3 h-3" />,
        text: 'Wants to connect',
        color: 'text-p01-cyan',
      };
    case 'blocked':
      return {
        icon: <X className="w-3 h-3" />,
        text: 'Blocked',
        color: 'text-red-500',
      };
    default:
      return {
        icon: <Lock className="w-3 h-3" />,
        text: 'Encrypted',
        color: 'text-p01-cyan',
      };
  }
}

export default function ContactCard({
  contact,
  lastMessage,
  lastMessageTime,
  unreadCount,
  onClick,
  onAccept,
  onReject,
  showActions = false,
  variant = 'default',
}: ContactCardProps) {
  const [showMenu, setShowMenu] = useState(false);

  const displayName = contact.nickname || truncateAddress(contact.walletAddress, 4);
  const avatarLetter = contact.nickname?.[0]?.toUpperCase() || contact.walletAddress[0];
  const gradient = getAvatarGradient(contact.avatarSeed || contact.walletAddress);
  const statusInfo = getStatusInfo(contact.status);

  // Pending request variant
  if (variant === 'request' || contact.status === 'pending_received') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: -100 }}
        className="p-4 bg-p01-surface rounded-xl"
      >
        <div className="flex items-center gap-3 mb-3">
          {/* Avatar */}
          <div
            className={cn(
              'w-12 h-12 rounded-full bg-gradient-to-br flex items-center justify-center flex-shrink-0',
              gradient
            )}
          >
            <span className="text-white font-bold">{avatarLetter}</span>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <p className="text-white font-medium truncate font-mono text-sm">
              {truncateAddress(contact.walletAddress, 6)}
            </p>
            <p className="text-p01-chrome text-xs">Wants to connect with you</p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={onAccept}
            className="flex-1 py-2.5 bg-p01-cyan text-p01-void font-medium rounded-lg text-sm flex items-center justify-center gap-2"
          >
            <Check className="w-4 h-4" />
            Accept
          </button>
          <button
            onClick={onReject}
            className="flex-1 py-2.5 bg-p01-surface border border-p01-border text-p01-chrome font-medium rounded-lg text-sm flex items-center justify-center gap-2 hover:text-white hover:border-red-500/50"
          >
            <X className="w-4 h-4" />
            Decline
          </button>
        </div>
      </motion.div>
    );
  }

  // Compact variant (for lists without messages)
  if (variant === 'compact') {
    return (
      <motion.button
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={onClick}
        className="w-full p-3 bg-p01-surface rounded-xl flex items-center gap-3 hover:bg-p01-surface/80 transition-colors"
      >
        {/* Avatar */}
        <div
          className={cn(
            'w-10 h-10 rounded-full bg-gradient-to-br flex items-center justify-center flex-shrink-0',
            gradient
          )}
        >
          <span className="text-white font-bold text-sm">{avatarLetter}</span>
        </div>

        {/* Info */}
        <div className="flex-1 text-left min-w-0">
          <p className="text-white font-medium truncate">{displayName}</p>
          <p className="text-p01-chrome/60 text-xs font-mono truncate">
            {truncateAddress(contact.walletAddress, 6)}
          </p>
        </div>

        {/* Favorite star */}
        {contact.isFavorite && (
          <Star className="w-4 h-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />
        )}
      </motion.button>
    );
  }

  // Default variant (conversation list item)
  return (
    <motion.button
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onClick}
      className="w-full p-3 bg-p01-surface rounded-xl flex items-center gap-3 hover:bg-p01-surface/80 transition-colors group"
    >
      {/* Avatar */}
      <div
        className={cn(
          'w-12 h-12 rounded-full bg-gradient-to-br flex items-center justify-center flex-shrink-0 relative',
          gradient
        )}
      >
        <span className="text-white font-bold">{avatarLetter}</span>

        {/* Favorite indicator */}
        {contact.isFavorite && (
          <div className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-500 rounded-full flex items-center justify-center">
            <Star className="w-2.5 h-2.5 text-white fill-white" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 text-left min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white font-medium truncate">{displayName}</p>
          {contact.status === 'accepted' && (
            <Lock className="w-3 h-3 text-p01-cyan flex-shrink-0" />
          )}
        </div>

        {contact.status === 'pending_sent' ? (
          <div className={cn('flex items-center gap-1 text-xs', statusInfo.color)}>
            {statusInfo.icon}
            <span>{statusInfo.text}</span>
          </div>
        ) : lastMessage ? (
          <p className="text-p01-chrome text-sm truncate">{lastMessage}</p>
        ) : (
          <p className="text-p01-chrome/60 text-xs font-mono truncate">
            {truncateAddress(contact.walletAddress, 8)}
          </p>
        )}
      </div>

      {/* Meta (time and unread) */}
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        {lastMessageTime && (
          <span className="text-p01-chrome/60 text-xs">{lastMessageTime}</span>
        )}

        {unreadCount && unreadCount > 0 ? (
          <span className="w-5 h-5 bg-p01-pink text-white text-[10px] rounded-full flex items-center justify-center font-bold">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : (
          showActions && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              className="p-1 text-p01-chrome/40 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          )
        )}
      </div>
    </motion.button>
  );
}
