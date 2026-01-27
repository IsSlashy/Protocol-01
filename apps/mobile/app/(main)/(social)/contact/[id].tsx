import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Share,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { ContactAvatar, ContactActions } from '@/components/social';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useContactsStore, formatAddress } from '@/stores/contactsStore';

const truncateAddress = (address: string, start = 8, end = 8): string => {
  if (address.length <= start + end) return address;
  return `${address.slice(0, start)}...${address.slice(-end)}`;
};

export default function ContactDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const {
    contacts,
    initialize,
    updateContact,
    removeContact,
  } = useContactsStore();

  // Toggle favorite using updateContact
  const toggleFavorite = async (contactId: string) => {
    const contact = contacts.find(c => c.id === contactId);
    if (contact) {
      await updateContact(contactId, { isFavorite: !contact.isFavorite });
    }
  };

  useEffect(() => {
    initialize();
  }, []);

  const storeContact = contacts.find((c) => c.id === id);

  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notes, setNotes] = useState(storeContact?.notes || '');

  // Update notes when contact loads
  useEffect(() => {
    if (storeContact) {
      setNotes(storeContact.notes || '');
    }
  }, [storeContact]);

  // Loading state
  if (!storeContact) {
    return (
      <SafeAreaView className="flex-1 bg-p01-void items-center justify-center">
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text className="text-p01-text-secondary mt-4">Loading contact...</Text>
      </SafeAreaView>
    );
  }

  // Transform contact to the format used in this component
  const contact = {
    id: storeContact.id,
    name: storeContact.alias,
    address: storeContact.address,
    avatar: storeContact.avatar,
    isFavorite: storeContact.isFavorite,
    notes: storeContact.notes || '',
    isP01User: storeContact.isP01User,
    canMessage: storeContact.canMessage,
    // No transaction history stored in contactsStore currently
    transactions: [] as { id: string; type: string; amount: number; currency: string; date: string; memo?: string }[],
  };

  const handleCopyAddress = async () => {
    await Clipboard.setStringAsync(contact.address);
    Alert.alert('Copied', 'Address copied to clipboard');
  };

  const handleShareAddress = async () => {
    try {
      await Share.share({
        message: `${contact.name}'s Solana address: ${contact.address}`,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  const handleSend = () => {
    router.push(`/(main)/(wallet)/send?to=${contact.address}`);
  };

  const handleRequest = () => {
    router.push(`/(main)/(social)/create-request?contact=${id}`);
  };

  const handleStream = () => {
    Alert.alert('Coming Soon', 'Payment streaming will be available soon!');
  };

  const handleToggleFavorite = async () => {
    try {
      await toggleFavorite(contact.id);
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    }
  };

  const handleEdit = () => {
    Alert.alert('Edit Contact', 'Edit contact functionality');
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Contact',
      `Are you sure you want to delete ${contact.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeContact(contact.id);
              router.back();
            } catch (error) {
              console.error('Failed to delete contact:', error);
            }
          },
        },
      ]
    );
  };

  const handleSaveNotes = () => {
    // TODO: Add updateContactNotes to contactsStore
    setIsEditingNotes(false);
  };

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 py-4">
        <TouchableOpacity
          className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
          onPress={() => router.back()}
          style={{
            borderWidth: 1,
            borderColor: 'rgba(59, 130, 246, 0.2)',
          }}
        >
          <Ionicons name="arrow-back" size={20} color="#3b82f6" />
        </TouchableOpacity>

        <View className="flex-row items-center gap-2">
          <TouchableOpacity
            className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
            onPress={handleToggleFavorite}
            style={{
              borderWidth: 1,
              borderColor: contact.isFavorite ? 'rgba(251, 191, 36, 0.3)' : 'rgba(59, 130, 246, 0.2)',
            }}
          >
            <Ionicons
              name={contact.isFavorite ? 'star' : 'star-outline'}
              size={20}
              color={contact.isFavorite ? '#fbbf24' : '#3b82f6'}
            />
          </TouchableOpacity>

          <TouchableOpacity
            className="w-10 h-10 rounded-full bg-p01-surface items-center justify-center"
            onPress={() =>
              Alert.alert('Menu', '', [
                { text: 'Edit', onPress: handleEdit },
                { text: 'Delete', style: 'destructive', onPress: handleDelete },
                { text: 'Cancel', style: 'cancel' },
              ])
            }
            style={{
              borderWidth: 1,
              borderColor: 'rgba(59, 130, 246, 0.2)',
            }}
          >
            <Ionicons name="ellipsis-vertical" size={20} color="#3b82f6" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* Profile Section */}
        <View className="items-center px-5 py-6">
          <ContactAvatar
            source={contact.avatar}
            name={contact.name}
            size="xl"
            showFavorite
            isFavorite={contact.isFavorite}
          />

          <Text className="text-white text-2xl font-bold mt-4">{contact.name}</Text>

          <View className="flex-row items-center mt-2">
            <Text className="text-p01-text-secondary text-sm">
              {truncateAddress(contact.address)}
            </Text>
          </View>

          <View className="flex-row items-center gap-3 mt-4">
            <TouchableOpacity
              className="flex-row items-center px-4 py-2 rounded-full bg-blue-500/20"
              onPress={handleCopyAddress}
            >
              <Ionicons name="copy-outline" size={16} color="#3b82f6" />
              <Text className="text-blue-400 font-medium ml-2">Copy</Text>
            </TouchableOpacity>

            <TouchableOpacity
              className="flex-row items-center px-4 py-2 rounded-full bg-blue-500/20"
              onPress={handleShareAddress}
            >
              <Ionicons name="share-outline" size={16} color="#3b82f6" />
              <Text className="text-blue-400 font-medium ml-2">Share</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Actions */}
        <View className="px-5 mb-6">
          <ContactActions
            onSend={handleSend}
            onRequest={handleRequest}
            onStream={handleStream}
          />
        </View>

        {/* Transaction History */}
        <View className="px-5 mb-6">
          <Text className="text-white font-semibold text-lg mb-3">History</Text>
          <Card variant="default" padding="none">
            {contact.transactions.map((tx, index) => (
              <TouchableOpacity
                key={tx.id}
                className={`flex-row items-center p-4 ${
                  index < contact.transactions.length - 1 ? 'border-b border-p01-border' : ''
                }`}
                activeOpacity={0.7}
              >
                <View
                  className={`w-10 h-10 rounded-full items-center justify-center ${
                    tx.type === 'sent' ? 'bg-red-500/20' : 'bg-green-500/20'
                  }`}
                >
                  <Ionicons
                    name={tx.type === 'sent' ? 'arrow-up' : 'arrow-down'}
                    size={20}
                    color={tx.type === 'sent' ? '#ef4444' : '#22c55e'}
                  />
                </View>

                <View className="flex-1 ml-3">
                  <Text className="text-white font-medium">
                    {tx.type === 'sent' ? 'Sent' : 'Received'}
                  </Text>
                  {tx.memo && (
                    <Text className="text-p01-text-secondary text-sm">{tx.memo}</Text>
                  )}
                </View>

                <View className="items-end">
                  <Text
                    className={`font-semibold ${
                      tx.type === 'sent' ? 'text-red-400' : 'text-green-400'
                    }`}
                  >
                    {tx.type === 'sent' ? '-' : '+'}{tx.amount} {tx.currency}
                  </Text>
                  <Text className="text-p01-text-secondary text-xs">{tx.date}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </Card>
        </View>

        {/* Notes Section */}
        <View className="px-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-white font-semibold text-lg">Notes</Text>
            {!isEditingNotes && (
              <TouchableOpacity onPress={() => setIsEditingNotes(true)}>
                <Ionicons name="pencil" size={18} color="#3b82f6" />
              </TouchableOpacity>
            )}
          </View>

          <Card variant="default" padding="md">
            {isEditingNotes ? (
              <View>
                <Input
                  value={notes}
                  onChangeText={setNotes}
                  multiline
                  numberOfLines={4}
                  placeholder="Add notes about this contact..."
                  style={{ minHeight: 100, textAlignVertical: 'top' }}
                />
                <View className="flex-row justify-end gap-3 mt-3">
                  <TouchableOpacity
                    className="px-4 py-2 rounded-lg"
                    onPress={() => {
                      setNotes(contact.notes);
                      setIsEditingNotes(false);
                    }}
                  >
                    <Text className="text-p01-text-secondary">Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    className="px-4 py-2 rounded-lg bg-blue-500"
                    onPress={handleSaveNotes}
                  >
                    <Text className="text-white font-semibold">Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <Text className="text-p01-text-secondary">
                {contact.notes || 'No notes added yet.'}
              </Text>
            )}
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
