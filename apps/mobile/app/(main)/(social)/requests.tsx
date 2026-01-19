import React, { useState, useMemo, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { RequestCard } from '@/components/social';
import { useContactsStore, formatAddress } from '@/stores/contactsStore';

type TabType = 'received' | 'sent';

export default function RequestsScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>('received');

  const {
    paymentRequests,
    contacts,
    encryptionKeys,
    initialize,
    respondToPaymentRequest,
  } = useContactsStore();

  useEffect(() => {
    initialize();
  }, []);

  // Transform payment requests to the format expected by RequestCard
  const transformedRequests = useMemo(() => {
    return paymentRequests.map((request) => {
      const isReceived = request.toAddress === encryptionKeys?.publicKey;
      const contactAddress = isReceived ? request.fromAddress : request.toAddress;
      const contact = contacts.find((c) => c.address === contactAddress);

      return {
        id: request.id,
        contactName: contact?.alias || formatAddress(contactAddress, 6),
        contactAvatar: contact?.avatar,
        amount: request.amount,
        currency: request.currency,
        message: request.memo || '',
        timestamp: new Date(request.createdAt).toISOString(),
        status: request.status === 'pending' ? 'pending' as const :
                request.status === 'completed' ? 'completed' as const :
                request.status === 'cancelled' ? 'declined' as const : 'declined' as const,
        type: isReceived ? 'received' as const : 'sent' as const,
      };
    });
  }, [paymentRequests, contacts, encryptionKeys]);

  const filteredRequests = useMemo(
    () => transformedRequests.filter((r) => r.type === activeTab),
    [activeTab, transformedRequests]
  );

  const pendingRequests = useMemo(
    () => filteredRequests.filter((r) => r.status === 'pending'),
    [filteredRequests]
  );

  const completedRequests = useMemo(
    () => filteredRequests.filter((r) => r.status !== 'pending'),
    [filteredRequests]
  );

  const handleDecline = (id: string) => {
    Alert.alert('Decline Request', 'Are you sure you want to decline this request?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Decline',
        style: 'destructive',
        onPress: async () => {
          try {
            await respondToPaymentRequest(id, 'cancel');
          } catch (error) {
            console.error('Failed to decline:', error);
          }
        },
      },
    ]);
  };

  const handlePay = (id: string, amount: number, contactName: string) => {
    Alert.alert(
      'Pay Request',
      `Send ${amount} SOL to ${contactName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay',
          onPress: async () => {
            try {
              await respondToPaymentRequest(id, 'pay');
            } catch (error) {
              console.error('Failed to pay:', error);
            }
          },
        },
      ]
    );
  };

  const handleCancelRequest = (id: string) => {
    Alert.alert('Cancel Request', 'Are you sure you want to cancel this request?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes, Cancel',
        style: 'destructive',
        onPress: async () => {
          try {
            await respondToPaymentRequest(id, 'cancel');
          } catch (error) {
            console.error('Failed to cancel:', error);
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-p01-void">
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
          Payment Requests
        </Text>
        <TouchableOpacity
          className="w-10 h-10 rounded-full bg-blue-500 items-center justify-center"
          onPress={() => router.push('/(main)/(social)/create-request')}
          style={{
            shadowColor: '#3b82f6',
            shadowOpacity: 0.5,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 2 },
            elevation: 6,
          }}
        >
          <Ionicons name="add" size={24} color="#ffffff" />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View className="flex-row mx-5 mb-4 p-1 bg-p01-surface rounded-xl">
        <TouchableOpacity
          className={`flex-1 py-3 rounded-lg ${
            activeTab === 'received' ? 'bg-blue-500' : ''
          }`}
          onPress={() => setActiveTab('received')}
          style={
            activeTab === 'received'
              ? {
                  shadowColor: '#3b82f6',
                  shadowOpacity: 0.4,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 4,
                }
              : undefined
          }
        >
          <Text
            className={`text-center font-semibold ${
              activeTab === 'received' ? 'text-white' : 'text-p01-text-secondary'
            }`}
          >
            Received
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          className={`flex-1 py-3 rounded-lg ${
            activeTab === 'sent' ? 'bg-blue-500' : ''
          }`}
          onPress={() => setActiveTab('sent')}
          style={
            activeTab === 'sent'
              ? {
                  shadowColor: '#3b82f6',
                  shadowOpacity: 0.4,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 4,
                }
              : undefined
          }
        >
          <Text
            className={`text-center font-semibold ${
              activeTab === 'sent' ? 'text-white' : 'text-p01-text-secondary'
            }`}
          >
            Sent
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        className="flex-1 px-5"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* Pending Section */}
        {pendingRequests.length > 0 && (
          <View className="mb-6">
            <View className="flex-row items-center mb-3">
              <View className="w-2 h-2 rounded-full bg-blue-500 mr-2" />
              <Text className="text-blue-400 font-semibold text-sm uppercase tracking-wider">
                Pending ({pendingRequests.length})
              </Text>
            </View>

            {pendingRequests.map((request) => (
              <RequestCard
                key={request.id}
                {...request}
                onDecline={
                  request.type === 'received'
                    ? () => handleDecline(request.id)
                    : () => handleCancelRequest(request.id)
                }
                onPay={
                  request.type === 'received'
                    ? () => handlePay(request.id, request.amount, request.contactName)
                    : undefined
                }
              />
            ))}
          </View>
        )}

        {/* Completed Section */}
        {completedRequests.length > 0 && (
          <View>
            <View className="flex-row items-center mb-3">
              <View className="w-2 h-2 rounded-full bg-p01-text-secondary mr-2" />
              <Text className="text-p01-text-secondary font-semibold text-sm uppercase tracking-wider">
                History ({completedRequests.length})
              </Text>
            </View>

            {completedRequests.map((request) => (
              <RequestCard key={request.id} {...request} />
            ))}
          </View>
        )}

        {/* Empty State */}
        {filteredRequests.length === 0 && (
          <View className="items-center justify-center py-20">
            <View
              className="w-20 h-20 rounded-full items-center justify-center mb-4"
              style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)' }}
            >
              <Ionicons name="receipt-outline" size={40} color="#3b82f6" />
            </View>
            <Text className="text-white font-semibold text-lg mb-1">
              No {activeTab} requests
            </Text>
            <Text className="text-p01-text-secondary text-center px-8">
              {activeTab === 'received'
                ? "You haven't received any payment requests yet."
                : "You haven't sent any payment requests yet."}
            </Text>
            {activeTab === 'sent' && (
              <TouchableOpacity
                className="mt-6 px-6 py-3 bg-blue-500 rounded-xl"
                onPress={() => router.push('/(main)/(social)/create-request')}
                style={{
                  shadowColor: '#3b82f6',
                  shadowOpacity: 0.4,
                  shadowRadius: 10,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 6,
                }}
              >
                <Text className="text-white font-semibold">Create Request</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
