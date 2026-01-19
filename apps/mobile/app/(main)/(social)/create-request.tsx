import React, { useState, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ContactAvatar } from '@/components/social';
import { Button } from '@/components/ui/Button';
import { useContactsStore, formatAddress } from '@/stores/contactsStore';

interface ContactItem {
  id: string;
  name: string;
  address: string;
}

export default function CreateRequestScreen() {
  const router = useRouter();
  const { contact: preselectedContactId } = useLocalSearchParams<{ contact?: string }>();

  const { contacts, initialize, createPaymentRequest } = useContactsStore();

  useEffect(() => {
    initialize();
  }, []);

  // Transform contacts to the format used in this component
  const contactsList: ContactItem[] = useMemo(() => {
    return contacts.map((c) => ({
      id: c.id,
      name: c.alias,
      address: c.address,
    }));
  }, [contacts]);

  const [selectedContact, setSelectedContact] = useState<ContactItem | null>(null);

  // Set preselected contact once contacts are loaded
  useEffect(() => {
    if (preselectedContactId && contactsList.length > 0 && !selectedContact) {
      const found = contactsList.find((c) => c.id === preselectedContactId);
      if (found) {
        setSelectedContact(found);
        setIsSelectingContact(false);
      }
    }
  }, [preselectedContactId, contactsList]);

  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSelectingContact, setIsSelectingContact] = useState(!preselectedContactId);
  const [loading, setLoading] = useState(false);

  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contactsList;
    const query = searchQuery.toLowerCase();
    return contactsList.filter(
      (contact) =>
        contact.name.toLowerCase().includes(query) ||
        contact.address.toLowerCase().includes(query)
    );
  }, [searchQuery, contactsList]);

  const handleSelectContact = (contact: ContactItem) => {
    setSelectedContact(contact);
    setIsSelectingContact(false);
    setSearchQuery('');
  };

  const handleAmountChange = (text: string) => {
    // Allow only numbers and one decimal point
    const sanitized = text.replace(/[^0-9.]/g, '');
    const parts = sanitized.split('.');
    if (parts.length > 2) return;
    if (parts[1]?.length > 9) return; // SOL has 9 decimal places
    setAmount(sanitized);
  };

  const handleSubmit = async () => {
    if (!selectedContact) {
      Alert.alert('Error', 'Please select a contact');
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    setLoading(true);

    try {
      await createPaymentRequest(
        selectedContact.address,
        amountNum,
        'SOL',
        message || undefined
      );

      Alert.alert(
        'Request Sent',
        `Payment request for ${amount} SOL sent to ${selectedContact.name}`,
        [
          {
            text: 'OK',
            onPress: () => router.back(),
          },
        ]
      );
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create payment request');
    } finally {
      setLoading(false);
    }
  };

  const isValid = selectedContact && parseFloat(amount) > 0;

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Header */}
        <View className="flex-row items-center px-5 py-4">
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
          <Text className="flex-1 text-white text-xl font-bold ml-4">
            Request Payment
          </Text>
        </View>

        <ScrollView
          className="flex-1 px-5"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Contact Selection */}
          <View className="mb-6">
            <Text className="text-p01-text-secondary text-sm mb-3 font-medium">
              REQUEST FROM
            </Text>

            {selectedContact && !isSelectingContact ? (
              <TouchableOpacity
                className="flex-row items-center p-4 bg-p01-surface rounded-2xl"
                onPress={() => setIsSelectingContact(true)}
                style={{
                  borderWidth: 1,
                  borderColor: 'rgba(59, 130, 246, 0.3)',
                }}
              >
                <ContactAvatar name={selectedContact.name} size="md" />
                <View className="flex-1 ml-3">
                  <Text className="text-white font-semibold">{selectedContact.name}</Text>
                  <Text className="text-p01-text-secondary text-sm">
                    {selectedContact.address}
                  </Text>
                </View>
                <Ionicons name="chevron-down" size={20} color="#3b82f6" />
              </TouchableOpacity>
            ) : (
              <View>
                <View
                  className="flex-row items-center bg-p01-surface rounded-xl px-4 py-3 mb-3"
                  style={{
                    borderWidth: 1,
                    borderColor: 'rgba(59, 130, 246, 0.2)',
                  }}
                >
                  <Ionicons name="search" size={20} color="#888888" />
                  <TextInput
                    className="flex-1 ml-3 text-white text-base"
                    placeholder="Search contacts..."
                    placeholderTextColor="#666666"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    autoCapitalize="none"
                  />
                </View>

                <View
                  className="bg-p01-surface rounded-2xl overflow-hidden"
                  style={{
                    borderWidth: 1,
                    borderColor: 'rgba(59, 130, 246, 0.1)',
                    maxHeight: 250,
                  }}
                >
                  <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false}>
                    {filteredContacts.map((contact, index) => (
                      <TouchableOpacity
                        key={contact.id}
                        className={`flex-row items-center p-4 ${
                          index < filteredContacts.length - 1
                            ? 'border-b border-p01-border'
                            : ''
                        }`}
                        onPress={() => handleSelectContact(contact)}
                        activeOpacity={0.7}
                      >
                        <ContactAvatar name={contact.name} size="sm" />
                        <View className="flex-1 ml-3">
                          <Text className="text-white font-medium">{contact.name}</Text>
                          <Text className="text-p01-text-secondary text-sm">
                            {contact.address}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    ))}

                    {filteredContacts.length === 0 && (
                      <View className="items-center py-8">
                        <Text className="text-p01-text-secondary">No contacts found</Text>
                      </View>
                    )}
                  </ScrollView>
                </View>
              </View>
            )}
          </View>

          {/* Amount Input */}
          <View className="mb-6">
            <Text className="text-p01-text-secondary text-sm mb-3 font-medium">
              AMOUNT
            </Text>

            <View
              className="bg-p01-surface rounded-2xl p-6 items-center"
              style={{
                borderWidth: 1,
                borderColor: 'rgba(59, 130, 246, 0.2)',
              }}
            >
              <View className="flex-row items-baseline">
                <TextInput
                  className="text-white text-5xl font-bold text-center"
                  placeholder="0"
                  placeholderTextColor="#666666"
                  value={amount}
                  onChangeText={handleAmountChange}
                  keyboardType="decimal-pad"
                  style={{ minWidth: 100 }}
                />
                <Text className="text-blue-400 text-2xl font-semibold ml-2">SOL</Text>
              </View>

              {/* Quick amount buttons */}
              <View className="flex-row gap-3 mt-6">
                {['1', '5', '10', '25'].map((value) => (
                  <TouchableOpacity
                    key={value}
                    className="px-4 py-2 rounded-full bg-blue-500/20"
                    onPress={() => setAmount(value)}
                  >
                    <Text className="text-blue-400 font-medium">{value}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>

          {/* Message Input */}
          <View className="mb-8">
            <Text className="text-p01-text-secondary text-sm mb-3 font-medium">
              MESSAGE (OPTIONAL)
            </Text>

            <View
              className="bg-p01-surface rounded-2xl"
              style={{
                borderWidth: 1,
                borderColor: 'rgba(59, 130, 246, 0.2)',
              }}
            >
              <TextInput
                className="text-white text-base p-4"
                placeholder="What's this request for?"
                placeholderTextColor="#666666"
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={3}
                style={{ minHeight: 100, textAlignVertical: 'top' }}
              />
            </View>
          </View>

          {/* Submit Button */}
          <Button
            onPress={handleSubmit}
            loading={loading}
            disabled={!isValid}
            fullWidth
            className="bg-blue-500"
            style={{
              shadowColor: '#3b82f6',
              shadowOpacity: isValid ? 0.4 : 0,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: isValid ? 8 : 0,
            }}
          >
            Send Request
          </Button>

          <View className="h-20" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
