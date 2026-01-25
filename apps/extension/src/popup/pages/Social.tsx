import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users,
  MessageCircle,
  UserPlus,
  Search,
  Check,
  X,
  Send,
  ArrowLeft,
  MoreVertical,
  DollarSign,
  Lock,
  Clock,
  Paperclip,
  Banknote,
} from 'lucide-react';
import { cn, truncateAddress, generateId } from '@/shared/utils';
import { useWalletStore } from '@/shared/store/wallet';
import { usePaymentRequestsStore } from '@/shared/store/paymentRequests';
import {
  PaymentRequest,
  PaymentSent,
  formatPaymentAmount,
} from '@/shared/services/paymentRequest';
import PaymentRequestModal from '@/popup/components/PaymentRequestModal';
import SendCryptoModal from '@/popup/components/SendCryptoModal';
import PaymentRequestBubble from '@/popup/components/PaymentRequestBubble';
import PaymentSentBubble from '@/popup/components/PaymentSentBubble';

// Contact interface
interface Contact {
  id: string;
  walletAddress: string;
  nickname?: string;
  status: 'pending_sent' | 'pending_received' | 'accepted';
  lastMessage?: string;
  lastMessageTime?: string;
  unreadCount?: number;
}

// Enhanced message type to support payment requests and transfers
interface Message {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: Date;
  type: 'text' | 'payment_request' | 'payment_sent';
  encrypted: boolean;
  // Payment data
  paymentRequestId?: string;
  paymentSentId?: string;
}

// Mock contacts (would come from storage/backend)
const mockContacts: Contact[] = [
  {
    id: '1',
    walletAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    nickname: 'Alice',
    status: 'accepted',
    lastMessage: 'Hey, thanks for the SOL!',
    lastMessageTime: '2m',
    unreadCount: 2,
  },
  {
    id: '2',
    walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    status: 'pending_received',
  },
];

type View = 'list' | 'add' | 'chat' | 'requests';

export default function Social() {
  const { publicKey, network, _keypair, refreshBalance } = useWalletStore();
  const {
    paymentRequests,
    sentPayments,
    isProcessing,
    createRequest,
    payPendingRequest,
    declinePendingRequest,
    sendCrypto,
  } = usePaymentRequestsStore();

  const [view, setView] = useState<View>('list');
  const [contacts, setContacts] = useState<Contact[]>(mockContacts);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [newWalletAddress, setNewWalletAddress] = useState('');
  const [addError, setAddError] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      from: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      to: publicKey || '',
      content: 'Hey! How are you?',
      timestamp: new Date(Date.now() - 1000 * 60 * 5),
      type: 'text',
      encrypted: true,
    },
    {
      id: '2',
      from: publicKey || '',
      to: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      content: 'Good! Just testing the wallet',
      timestamp: new Date(Date.now() - 1000 * 60 * 3),
      type: 'text',
      encrypted: true,
    },
  ]);
  const [newMessage, setNewMessage] = useState('');

  // Modal states
  const [showPaymentRequestModal, setShowPaymentRequestModal] = useState(false);
  const [showSendCryptoModal, setShowSendCryptoModal] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [payingRequestId, setPayingRequestId] = useState<string | null>(null);

  // Ref for scrolling to bottom of messages
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const pendingRequests = contacts.filter((c) => c.status === 'pending_received');
  const acceptedContacts = contacts.filter((c) => c.status === 'accepted');

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, paymentRequests, sentPayments]);

  const handleAddContact = () => {
    setAddError('');

    if (!newWalletAddress.trim()) {
      setAddError('Please enter a wallet address');
      return;
    }

    if (newWalletAddress.length < 32 || newWalletAddress.length > 44) {
      setAddError('Invalid Solana wallet address');
      return;
    }

    if (newWalletAddress === publicKey) {
      setAddError("You can't add yourself");
      return;
    }

    if (contacts.some((c) => c.walletAddress === newWalletAddress)) {
      setAddError('Contact already exists');
      return;
    }

    const newContact: Contact = {
      id: Date.now().toString(),
      walletAddress: newWalletAddress,
      status: 'pending_sent',
    };

    setContacts([...contacts, newContact]);
    setNewWalletAddress('');
    setView('list');
  };

  const handleAcceptRequest = (contact: Contact) => {
    setContacts(
      contacts.map((c) =>
        c.id === contact.id ? { ...c, status: 'accepted' as const } : c
      )
    );
  };

  const handleRejectRequest = (contact: Contact) => {
    setContacts(contacts.filter((c) => c.id !== contact.id));
  };

  const handleSendMessage = () => {
    if (!newMessage.trim() || !selectedContact) return;

    const message: Message = {
      id: generateId(),
      from: publicKey || '',
      to: selectedContact.walletAddress,
      content: newMessage,
      timestamp: new Date(),
      type: 'text',
      encrypted: true,
    };

    setMessages([...messages, message]);
    setNewMessage('');
  };

  const openChat = (contact: Contact) => {
    setSelectedContact(contact);
    setView('chat');
  };

  // Handle creating a payment request
  const handleCreatePaymentRequest = (data: {
    amount: number;
    token: string;
    tokenMint?: string;
    note?: string;
    expiresIn?: number;
  }) => {
    if (!selectedContact || !publicKey) return;

    const request = createRequest(
      {
        recipient: selectedContact.walletAddress,
        amount: data.amount,
        token: data.token,
        tokenMint: data.tokenMint,
        note: data.note,
        expiresIn: data.expiresIn,
      },
      publicKey
    );

    // Add message to chat
    const message: Message = {
      id: generateId(),
      from: publicKey,
      to: selectedContact.walletAddress,
      content: `Requested ${formatPaymentAmount(data.amount, data.token)}`,
      timestamp: new Date(),
      type: 'payment_request',
      encrypted: true,
      paymentRequestId: request.id,
    };

    setMessages([...messages, message]);
    setShowPaymentRequestModal(false);
  };

  // Handle sending crypto
  const handleSendCrypto = async (data: {
    amount: number;
    token: string;
    tokenMint?: string;
    note?: string;
  }) => {
    if (!selectedContact || !_keypair) return;

    const result = await sendCrypto({
      keypair: _keypair,
      recipient: selectedContact.walletAddress,
      amount: data.amount,
      token: data.token,
      tokenMint: data.tokenMint,
      note: data.note,
      network,
    });

    // Add message to chat
    const message: Message = {
      id: generateId(),
      from: publicKey || '',
      to: selectedContact.walletAddress,
      content: `Sent ${formatPaymentAmount(data.amount, data.token)}`,
      timestamp: new Date(),
      type: 'payment_sent',
      encrypted: true,
      paymentSentId: result.payment.id,
    };

    setMessages([...messages, message]);
    setShowSendCryptoModal(false);

    // Refresh balance
    refreshBalance();
  };

  // Handle paying a payment request
  const handlePayRequest = async (requestId: string) => {
    if (!_keypair) return;

    setPayingRequestId(requestId);
    try {
      await payPendingRequest(requestId, _keypair, network);
      refreshBalance();
    } catch (error) {
      console.error('Failed to pay request:', error);
    } finally {
      setPayingRequestId(null);
    }
  };

  // Handle declining a payment request
  const handleDeclineRequest = (requestId: string) => {
    declinePendingRequest(requestId);
  };

  // Get payment request by ID
  const getPaymentRequest = (id: string): PaymentRequest | undefined => {
    return paymentRequests.find((r) => r.id === id);
  };

  // Get payment sent by ID
  const getPaymentSent = (id: string): PaymentSent | undefined => {
    return sentPayments.find((p) => p.id === id);
  };

  // List View
  if (view === 'list') {
    return (
      <div className="flex flex-col h-full bg-p01-void">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-p01-border">
          <h1 className="text-white font-display font-bold tracking-wide">Messages</h1>
          <div className="flex items-center gap-2">
            {pendingRequests.length > 0 && (
              <button
                onClick={() => setView('requests')}
                className="relative p-2 text-p01-chrome hover:text-white transition-colors"
              >
                <Users className="w-5 h-5" />
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-p01-pink text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                  {pendingRequests.length}
                </span>
              </button>
            )}
            <button
              onClick={() => setView('add')}
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
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-p01-surface rounded-xl text-white text-sm placeholder-p01-chrome/40 focus:outline-none focus:ring-1 focus:ring-p01-cyan"
            />
          </div>
        </div>

        {/* Contacts List */}
        <div className="flex-1 overflow-y-auto px-4">
          {acceptedContacts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="w-16 h-16 rounded-full bg-p01-surface flex items-center justify-center mb-4">
                <MessageCircle className="w-8 h-8 text-p01-chrome/40" />
              </div>
              <p className="text-white font-medium mb-1">No contacts yet</p>
              <p className="text-p01-chrome text-sm text-center mb-4">
                Add friends by their wallet address to start chatting
              </p>
              <button
                onClick={() => setView('add')}
                className="px-4 py-2 bg-p01-cyan text-p01-void font-medium rounded-lg text-sm"
              >
                Add Contact
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {acceptedContacts
                .filter(
                  (c) =>
                    c.nickname?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    c.walletAddress.toLowerCase().includes(searchQuery.toLowerCase())
                )
                .map((contact) => (
                  <motion.button
                    key={contact.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => openChat(contact)}
                    className="w-full p-3 bg-p01-surface rounded-xl flex items-center gap-3 hover:bg-p01-surface/80 transition-colors"
                  >
                    {/* Avatar */}
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-p01-pink to-p01-cyan flex items-center justify-center">
                      <span className="text-white font-bold">
                        {contact.nickname?.[0] || contact.walletAddress[0]}
                      </span>
                    </div>

                    {/* Info */}
                    <div className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium truncate">
                          {contact.nickname || truncateAddress(contact.walletAddress, 4)}
                        </p>
                        <Lock className="w-3 h-3 text-p01-cyan flex-shrink-0" />
                      </div>
                      {contact.lastMessage && (
                        <p className="text-p01-chrome text-sm truncate">
                          {contact.lastMessage}
                        </p>
                      )}
                    </div>

                    {/* Meta */}
                    <div className="flex flex-col items-end gap-1">
                      {contact.lastMessageTime && (
                        <span className="text-p01-chrome/60 text-xs">
                          {contact.lastMessageTime}
                        </span>
                      )}
                      {contact.unreadCount && contact.unreadCount > 0 && (
                        <span className="w-5 h-5 bg-p01-pink text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                          {contact.unreadCount}
                        </span>
                      )}
                    </div>
                  </motion.button>
                ))}
            </div>
          )}

          {/* Pending Sent Requests */}
          {contacts.filter((c) => c.status === 'pending_sent').length > 0 && (
            <div className="mt-4">
              <p className="text-p01-chrome/60 text-xs font-medium mb-2 tracking-wider">
                PENDING REQUESTS
              </p>
              {contacts
                .filter((c) => c.status === 'pending_sent')
                .map((contact) => (
                  <div
                    key={contact.id}
                    className="p-3 bg-p01-surface/50 rounded-xl flex items-center gap-3 mb-2"
                  >
                    <div className="w-10 h-10 rounded-full bg-p01-surface flex items-center justify-center">
                      <Clock className="w-5 h-5 text-p01-chrome/40" />
                    </div>
                    <div className="flex-1">
                      <p className="text-p01-chrome text-sm">
                        {truncateAddress(contact.walletAddress, 4)}
                      </p>
                      <p className="text-p01-chrome/60 text-xs">Waiting for response...</p>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Add Contact View
  if (view === 'add') {
    return (
      <div className="flex flex-col h-full bg-p01-void">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
          <button
            onClick={() => setView('list')}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-white font-display font-bold tracking-wide">Add Contact</h1>
        </header>

        {/* Content */}
        <div className="flex-1 p-4">
          <div className="text-center mb-6">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-p01-pink to-p01-cyan flex items-center justify-center mx-auto mb-4">
              <UserPlus className="w-8 h-8 text-white" />
            </div>
            <h2 className="text-white font-display font-bold text-lg mb-1">
              Add by Wallet Address
            </h2>
            <p className="text-p01-chrome text-sm">
              They'll receive a request to connect with you
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-p01-chrome text-xs font-medium mb-2 block tracking-wider">
                WALLET ADDRESS
              </label>
              <input
                type="text"
                placeholder="Enter Solana wallet address..."
                value={newWalletAddress}
                onChange={(e) => {
                  setNewWalletAddress(e.target.value);
                  setAddError('');
                }}
                className="w-full px-4 py-3 bg-p01-surface rounded-xl text-white text-sm placeholder-p01-chrome/40 focus:outline-none focus:ring-1 focus:ring-p01-cyan font-mono"
              />
              {addError && (
                <p className="text-red-400 text-xs mt-2">{addError}</p>
              )}
            </div>

            <div className="p-4 bg-p01-surface rounded-xl">
              <div className="flex items-start gap-3">
                <Lock className="w-5 h-5 text-p01-cyan flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-white text-sm font-medium mb-1">End-to-End Encrypted</p>
                  <p className="text-p01-chrome text-xs">
                    All messages between you and your contacts are encrypted. Only you and your
                    contact can read them.
                  </p>
                </div>
              </div>
            </div>

            <button
              onClick={handleAddContact}
              disabled={!newWalletAddress.trim()}
              className={cn(
                'w-full py-3 rounded-xl font-display font-bold text-sm tracking-wider transition-colors',
                newWalletAddress.trim()
                  ? 'bg-p01-cyan text-p01-void hover:bg-p01-cyan/90'
                  : 'bg-p01-surface text-p01-chrome/40 cursor-not-allowed'
              )}
            >
              SEND REQUEST
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Friend Requests View
  if (view === 'requests') {
    return (
      <div className="flex flex-col h-full bg-p01-void">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
          <button
            onClick={() => setView('list')}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-white font-display font-bold tracking-wide">Friend Requests</h1>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {pendingRequests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="w-16 h-16 rounded-full bg-p01-surface flex items-center justify-center mb-4">
                <Users className="w-8 h-8 text-p01-chrome/40" />
              </div>
              <p className="text-white font-medium mb-1">No pending requests</p>
              <p className="text-p01-chrome text-sm">
                Friend requests will appear here
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <AnimatePresence>
                {pendingRequests.map((contact) => (
                  <motion.div
                    key={contact.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -100 }}
                    className="p-4 bg-p01-surface rounded-xl"
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-p01-cyan to-p01-cyan-dim flex items-center justify-center">
                        <span className="text-white font-bold">
                          {contact.walletAddress[0]}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-medium truncate font-mono text-sm">
                          {truncateAddress(contact.walletAddress, 6)}
                        </p>
                        <p className="text-p01-chrome text-xs">
                          Wants to connect with you
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleAcceptRequest(contact)}
                        className="flex-1 py-2.5 bg-p01-cyan text-p01-void font-medium rounded-lg text-sm flex items-center justify-center gap-2"
                      >
                        <Check className="w-4 h-4" />
                        Accept
                      </button>
                      <button
                        onClick={() => handleRejectRequest(contact)}
                        className="flex-1 py-2.5 bg-p01-surface border border-p01-border text-p01-chrome font-medium rounded-lg text-sm flex items-center justify-center gap-2 hover:text-white hover:border-red-500/50"
                      >
                        <X className="w-4 h-4" />
                        Decline
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Chat View
  if (view === 'chat' && selectedContact) {
    const contactMessages = messages.filter(
      (m) =>
        (m.from === selectedContact.walletAddress && m.to === publicKey) ||
        (m.to === selectedContact.walletAddress && m.from === publicKey)
    );

    // Payment requests and sent payments for this contact are handled through messages
    // The MessageBubble component renders payment_request and payment_sent message types

    return (
      <div className="flex flex-col h-full bg-p01-void">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-p01-border">
          <button
            onClick={() => {
              setView('list');
              setSelectedContact(null);
            }}
            className="p-2 -ml-2 text-p01-chrome hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-3 flex-1">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-p01-pink to-p01-cyan flex items-center justify-center">
              <span className="text-white font-bold text-sm">
                {selectedContact.nickname?.[0] || selectedContact.walletAddress[0]}
              </span>
            </div>
            <div>
              <p className="text-white font-medium">
                {selectedContact.nickname || truncateAddress(selectedContact.walletAddress, 4)}
              </p>
              <div className="flex items-center gap-1 text-p01-cyan text-xs">
                <Lock className="w-3 h-3" />
                <span>Encrypted</span>
              </div>
            </div>
          </div>
          <button className="p-2 text-p01-chrome hover:text-white transition-colors">
            <MoreVertical className="w-5 h-5" />
          </button>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {contactMessages.map((message) => {
            const isMe = message.from === publicKey;

            // Render payment request bubble
            if (message.type === 'payment_request' && message.paymentRequestId) {
              const request = getPaymentRequest(message.paymentRequestId);
              if (request) {
                return (
                  <PaymentRequestBubble
                    key={message.id}
                    request={request}
                    isFromMe={request.requesterId === publicKey}
                    contactName={selectedContact.nickname}
                    onPay={() => handlePayRequest(request.id)}
                    onDecline={() => handleDeclineRequest(request.id)}
                    isPaying={payingRequestId === request.id}
                  />
                );
              }
            }

            // Render payment sent bubble
            if (message.type === 'payment_sent' && message.paymentSentId) {
              const payment = getPaymentSent(message.paymentSentId);
              if (payment) {
                return (
                  <PaymentSentBubble
                    key={message.id}
                    payment={payment}
                    isFromMe={payment.senderId === publicKey}
                    contactName={selectedContact.nickname}
                    network={network}
                  />
                );
              }
            }

            // Render regular text message
            return (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn('flex', isMe ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-2xl px-4 py-2.5',
                    isMe
                      ? 'bg-p01-cyan text-p01-void rounded-br-sm'
                      : 'bg-p01-surface text-white rounded-bl-sm'
                  )}
                >
                  <p className="text-sm">{message.content}</p>
                  <p
                    className={cn(
                      'text-[10px] mt-1',
                      isMe ? 'text-p01-void/60' : 'text-p01-chrome/60'
                    )}
                  >
                    {message.timestamp.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </motion.div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input with Actions */}
        <div className="p-4 border-t border-p01-border">
          <div className="flex items-center gap-2">
            {/* Actions Menu Button */}
            <div className="relative">
              <button
                onClick={() => setShowActionsMenu(!showActionsMenu)}
                className={cn(
                  'p-2.5 rounded-xl transition-colors',
                  showActionsMenu
                    ? 'bg-p01-cyan text-p01-void'
                    : 'bg-p01-surface text-p01-chrome hover:text-white'
                )}
              >
                <Paperclip className="w-5 h-5" />
              </button>

              {/* Actions Dropdown */}
              <AnimatePresence>
                {showActionsMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute bottom-full left-0 mb-2 bg-p01-surface border border-p01-border rounded-xl shadow-xl overflow-hidden min-w-[180px]"
                  >
                    <button
                      onClick={() => {
                        setShowActionsMenu(false);
                        setShowPaymentRequestModal(true);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-p01-elevated transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-p01-pink/20 flex items-center justify-center">
                        <DollarSign className="w-4 h-4 text-p01-pink" />
                      </div>
                      <div className="text-left">
                        <p className="text-white text-sm font-medium">Request Payment</p>
                        <p className="text-p01-chrome text-[10px]">Ask for crypto</p>
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        setShowActionsMenu(false);
                        setShowSendCryptoModal(true);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-p01-elevated transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                        <Banknote className="w-4 h-4 text-green-400" />
                      </div>
                      <div className="text-left">
                        <p className="text-white text-sm font-medium">Send Crypto</p>
                        <p className="text-p01-chrome text-[10px]">Transfer tokens</p>
                      </div>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Message Input */}
            <input
              type="text"
              placeholder="Type a message..."
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              className="flex-1 px-4 py-2.5 bg-p01-surface rounded-xl text-white text-sm placeholder-p01-chrome/40 focus:outline-none focus:ring-1 focus:ring-p01-cyan"
            />

            {/* Send Button */}
            <button
              onClick={handleSendMessage}
              disabled={!newMessage.trim()}
              className={cn(
                'p-2.5 rounded-xl transition-colors',
                newMessage.trim()
                  ? 'bg-p01-cyan text-p01-void'
                  : 'bg-p01-surface text-p01-chrome/40'
              )}
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Payment Request Modal */}
        <PaymentRequestModal
          isOpen={showPaymentRequestModal}
          onClose={() => setShowPaymentRequestModal(false)}
          onSubmit={handleCreatePaymentRequest}
          contactName={selectedContact.nickname}
          contactAddress={selectedContact.walletAddress}
        />

        {/* Send Crypto Modal */}
        <SendCryptoModal
          isOpen={showSendCryptoModal}
          onClose={() => setShowSendCryptoModal(false)}
          onSubmit={handleSendCrypto}
          contactName={selectedContact.nickname}
          contactAddress={selectedContact.walletAddress}
          isProcessing={isProcessing}
        />
      </div>
    );
  }

  return null;
}
