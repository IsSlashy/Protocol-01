import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Platform,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import PagerView from 'react-native-pager-view';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  FadeInDown,
  FadeIn,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { useMeshStore, Chat, ConnectionRequestStatus } from '@/stores/meshStore';
import { useContactsStore, formatAddress } from '@/stores/contactsStore';
import { formatLastSeen, MeshPeer } from '@/services/mesh/bluetooth';
import { MeshZone, getZoneFromRSSI, ZONE_CONFIG } from '@/services/mesh/zones';
import { ProximityBump } from '@/components/mesh/ProximityBump';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Theme colors
const COLORS = {
  primary: '#00ff88',
  cyan: '#00D1FF',
  purple: '#9945FF',
  orange: '#f59e0b',
  background: '#050505',
  surface: '#0a0a0a',
  surfaceSecondary: '#111111',
  surfaceTertiary: '#1a1a1a',
  border: '#1f1f1f',
  borderLight: '#2a2a2a',
  text: '#ffffff',
  textSecondary: '#a0a0a0',
  textTertiary: '#666666',
};

type SocialMode = 'classic' | 'mesh';
type ClassicTab = 'chats' | 'contacts' | 'requests';
type MeshTab = 'zones' | 'peers' | 'queue';

export default function SocialScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Mode state
  const [mode, setMode] = useState<SocialMode>('mesh');
  const [classicTab, setClassicTab] = useState<ClassicTab>('chats');
  const [meshTab, setMeshTab] = useState<MeshTab>('zones');

  // Swipe navigation refs
  const meshPagerRef = useRef<PagerView>(null);
  const classicPagerRef = useRef<PagerView>(null);

  // Tab indicator animation
  const meshTabProgress = useSharedValue(0);
  const classicTabProgress = useSharedValue(0);

  // Tab configurations
  const MESH_TABS: MeshTab[] = ['zones', 'peers', 'queue'];
  const CLASSIC_TABS: ClassicTab[] = ['chats', 'contacts', 'requests'];
  // Calculate tab width: screen width minus header padding (40) minus internal tabs padding (8)
  const TAB_WIDTH = (SCREEN_WIDTH - 48) / 3;

  // Mesh store
  const {
    identity: meshIdentity,
    isInitialized: meshInitialized,
    isScanning,
    isBroadcasting,
    nearbyPeers,
    trustedPeers,
    peersByZone,
    zoneIndicators,
    meshStats,
    chats: meshChats,
    pendingTransactions,
    txQueueStats,
    connectionRequests,
    pendingConnectionCount,
    meshContacts,
    proximity,
    initialize: initializeMesh,
    startScanning,
    startBroadcasting,
    stopBroadcasting,
    trustPeer,
    connectToPeer,
    sendConnectionRequest,
    acceptConnectionRequest,
    rejectConnectionRequest,
    dismissProximityBump,
  } = useMeshStore();

  // Contacts store
  const {
    contacts,
    conversations,
    pendingPayments,
    isInitialized: contactsInitialized,
    initialize: initializeContacts,
  } = useContactsStore();

  useEffect(() => {
    initializeContacts();
    initializeMesh();
  }, []);

  useEffect(() => {
    if (meshInitialized && mode === 'mesh') {
      startBroadcasting();
      startScanning();
    }
  }, [meshInitialized, mode]);

  const handleRefresh = async () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (mode === 'mesh') {
      await startScanning();
    } else {
      await initializeContacts();
    }
  };

  const switchMode = (newMode: SocialMode) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setMode(newMode);
  };

  const handleContactPress = (contactId: string) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.push({
      pathname: '/(main)/(social)/conversation',
      params: { contactId },
    });
  };

  const handlePeerPress = (peerId: string, peerAlias: string) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    router.push({
      pathname: '/(main)/(social)/chat',
      params: { peerId, peerAlias },
    });
  };

  const handleTrustPeer = async (peerId: string) => {
    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    await trustPeer(peerId);
  };

  const handleConnectPeer = async (peerId: string) => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    await connectToPeer(peerId);
  };

  const toggleBroadcast = () => {
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (isBroadcasting) {
      stopBroadcasting();
    } else {
      startBroadcasting();
    }
  };

  // Handle mesh tab page change
  const handleMeshPageScroll = useCallback((event: any) => {
    const { position, offset } = event.nativeEvent;
    meshTabProgress.value = position + offset;
  }, []);

  const handleMeshPageSelected = useCallback((event: any) => {
    const index = event.nativeEvent.position;
    const newTab = MESH_TABS[index];
    if (newTab && newTab !== meshTab) {
      setMeshTab(newTab);
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  }, [meshTab]);

  // Handle classic tab page change
  const handleClassicPageScroll = useCallback((event: any) => {
    const { position, offset } = event.nativeEvent;
    classicTabProgress.value = position + offset;
  }, []);

  const handleClassicPageSelected = useCallback((event: any) => {
    const index = event.nativeEvent.position;
    const newTab = CLASSIC_TABS[index];
    if (newTab && newTab !== classicTab) {
      setClassicTab(newTab);
      if (Platform.OS !== 'web') {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  }, [classicTab]);

  // Navigate to tab when tapped
  const scrollToMeshTab = (index: number) => {
    meshPagerRef.current?.setPage(index);
    setMeshTab(MESH_TABS[index]);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const scrollToClassicTab = (index: number) => {
    classicPagerRef.current?.setPage(index);
    setClassicTab(CLASSIC_TABS[index]);
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // Animated tab indicator styles
  const meshIndicatorStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: withTiming(meshTabProgress.value * TAB_WIDTH, { duration: 100 }) }],
    };
  });

  const classicIndicatorStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: withTiming(classicTabProgress.value * TAB_WIDTH, { duration: 100 }) }],
    };
  });

  // Update shared values when tab changes via tap
  useEffect(() => {
    const index = MESH_TABS.indexOf(meshTab);
    meshTabProgress.value = withTiming(index, { duration: 200 });
  }, [meshTab]);

  useEffect(() => {
    const index = CLASSIC_TABS.indexOf(classicTab);
    classicTabProgress.value = withTiming(index, { duration: 200 });
  }, [classicTab]);

  // Render Zone Card
  const renderZoneCard = (zone: MeshZone, peers: MeshPeer[]) => {
    const config = ZONE_CONFIG[zone];
    const isActive = peers.length > 0;

    return (
      <Animated.View
        key={zone}
        entering={FadeInDown.delay(100)}
        style={{
          backgroundColor: COLORS.surfaceSecondary,
          borderRadius: 16,
          padding: 16,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: isActive ? config.color + '40' : COLORS.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: config.color + '20',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 12,
            }}
          >
            <Ionicons name={config.icon as any} size={22} color={config.color} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: config.color, fontSize: 16, fontWeight: '700' }}>
                {config.name} Zone
              </Text>
              {isActive && (
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: config.color,
                    marginLeft: 8,
                  }}
                />
              )}
            </View>
            <Text style={{ color: COLORS.textTertiary, fontSize: 12 }}>
              {config.description} • {peers.length} peers
            </Text>
          </View>
          {config.canTransact && (
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 4,
                backgroundColor: COLORS.primary + '20',
                borderRadius: 8,
              }}
            >
              <Text style={{ color: COLORS.primary, fontSize: 10, fontWeight: '600' }}>
                TX
              </Text>
            </View>
          )}
        </View>

        {peers.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {peers.slice(0, 6).map((peer) => (
              <TouchableOpacity
                key={peer.id}
                onPress={() => handlePeerPress(peer.id, peer.alias)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: COLORS.surfaceTertiary,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 20,
                }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: peer.isTrusted ? COLORS.primary + '30' : COLORS.purple + '30',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: 6,
                  }}
                >
                  <Text style={{ color: peer.isTrusted ? COLORS.primary : COLORS.purple, fontSize: 10, fontWeight: '600' }}>
                    {peer.alias.charAt(0)}
                  </Text>
                </View>
                <Text style={{ color: COLORS.text, fontSize: 12 }}>
                  {peer.alias.slice(0, 12)}
                </Text>
                {peer.isConnected && (
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: COLORS.primary,
                      marginLeft: 4,
                    }}
                  />
                )}
              </TouchableOpacity>
            ))}
            {peers.length > 6 && (
              <View
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  backgroundColor: COLORS.surfaceTertiary,
                  borderRadius: 20,
                }}
              >
                <Text style={{ color: COLORS.textSecondary, fontSize: 12 }}>
                  +{peers.length - 6}
                </Text>
              </View>
            )}
          </View>
        )}

        {peers.length === 0 && (
          <Text style={{ color: COLORS.textTertiary, fontSize: 12, fontStyle: 'italic' }}>
            No peers in range
          </Text>
        )}
      </Animated.View>
    );
  };

  // Render Mesh Stats
  const renderMeshStats = () => (
    <Animated.View entering={FadeInDown.delay(50)} style={{ marginBottom: 16 }}>
      <LinearGradient
        colors={[COLORS.surfaceSecondary, COLORS.surface]}
        style={{
          borderRadius: 16,
          padding: 16,
          borderWidth: 1,
          borderColor: COLORS.cyan + '20',
        }}
      >
        {/* Mesh Strength */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: COLORS.textTertiary, fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>
              MESH STRENGTH
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <Text style={{ color: COLORS.text, fontSize: 32, fontWeight: '700' }}>
                {meshStats.meshStrength}
              </Text>
              <Text style={{ color: COLORS.textSecondary, fontSize: 16, marginLeft: 4 }}>%</Text>
            </View>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: COLORS.textTertiary, fontSize: 10, letterSpacing: 1 }}>
              ENCRYPTION
            </Text>
            <Text style={{ color: COLORS.cyan, fontSize: 12, fontWeight: '600' }}>
              AES-256-GCM
            </Text>
          </View>
        </View>

        {/* Strength Bar */}
        <View
          style={{
            height: 6,
            backgroundColor: COLORS.surfaceTertiary,
            borderRadius: 3,
            marginBottom: 16,
            overflow: 'hidden',
          }}
        >
          <LinearGradient
            colors={[COLORS.primary, COLORS.cyan]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{
              height: '100%',
              width: `${meshStats.meshStrength}%`,
              borderRadius: 3,
            }}
          />
        </View>

        {/* Zone Indicators */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {zoneIndicators.map((indicator) => (
            <View key={indicator.zone} style={{ alignItems: 'center' }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: indicator.isActive ? indicator.color + '20' : COLORS.surfaceTertiary,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderWidth: 2,
                  borderColor: indicator.isActive ? indicator.color : COLORS.border,
                }}
              >
                <Text
                  style={{
                    color: indicator.isActive ? indicator.color : COLORS.textTertiary,
                    fontSize: 16,
                    fontWeight: '700',
                  }}
                >
                  {indicator.label}
                </Text>
              </View>
              <Text style={{ color: COLORS.textTertiary, fontSize: 10, marginTop: 4 }}>
                {indicator.peerCount}
              </Text>
            </View>
          ))}
        </View>
      </LinearGradient>
    </Animated.View>
  );

  // Render Peer Item
  const renderPeerItem = (peer: MeshPeer, index: number) => {
    const zone = getZoneFromRSSI(peer.rssi);
    const zoneConfig = ZONE_CONFIG[zone];

    return (
      <Animated.View key={peer.id} entering={FadeInDown.delay(100 + index * 50)}>
        <TouchableOpacity
          onPress={() => handlePeerPress(peer.id, peer.alias)}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: COLORS.surfaceSecondary,
            borderRadius: 16,
            padding: 14,
            marginBottom: 10,
            borderWidth: 1,
            borderColor: peer.isConnected ? zoneConfig.color + '40' : COLORS.border,
          }}
        >
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: peer.isTrusted ? COLORS.primary + '20' : zoneConfig.color + '20',
              justifyContent: 'center',
              alignItems: 'center',
              marginRight: 12,
            }}
          >
            <Text
              style={{
                color: peer.isTrusted ? COLORS.primary : zoneConfig.color,
                fontSize: 18,
                fontWeight: 'bold',
              }}
            >
              {peer.alias.charAt(0)}
            </Text>
            {peer.isConnected && (
              <View
                style={{
                  position: 'absolute',
                  bottom: 0,
                  right: 0,
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: COLORS.primary,
                  borderWidth: 2,
                  borderColor: COLORS.surfaceSecondary,
                }}
              />
            )}
          </View>

          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>
                {peer.alias}
              </Text>
              {peer.isTrusted && (
                <Ionicons
                  name="shield-checkmark"
                  size={14}
                  color={COLORS.primary}
                  style={{ marginLeft: 6 }}
                />
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: zoneConfig.color + '20',
                  borderRadius: 4,
                  marginRight: 8,
                }}
              >
                <Text style={{ color: zoneConfig.color, fontSize: 10, fontWeight: '600' }}>
                  {zoneConfig.name}
                </Text>
              </View>
              <Ionicons name="radio-outline" size={12} color={COLORS.textTertiary} />
              <Text style={{ color: COLORS.textTertiary, fontSize: 12, marginLeft: 4 }}>
                {peer.distance}
              </Text>
              <Text style={{ color: COLORS.textTertiary, fontSize: 11, marginLeft: 8 }}>
                • {formatLastSeen(peer.lastSeen)}
              </Text>
            </View>
          </View>

          {!peer.isConnected && (
            <TouchableOpacity
              onPress={() => handleConnectPeer(peer.id)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: COLORS.cyan + '20',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons name="link" size={18} color={COLORS.cyan} />
            </TouchableOpacity>
          )}

          {peer.isConnected && !peer.isTrusted && (
            <TouchableOpacity
              onPress={() => handleTrustPeer(peer.id)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: COLORS.primary + '15',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons name="person-add" size={16} color={COLORS.primary} />
            </TouchableOpacity>
          )}
        </TouchableOpacity>
      </Animated.View>
    );
  };

  // Render Tx Queue
  const renderTxQueue = () => (
    <View>
      <Animated.View entering={FadeInDown.delay(50)}>
        <LinearGradient
          colors={[COLORS.surfaceSecondary, COLORS.surface]}
          style={{
            borderRadius: 16,
            padding: 16,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: COLORS.orange + '20',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <Ionicons name="time-outline" size={20} color={COLORS.orange} style={{ marginRight: 8 }} />
            <Text style={{ color: COLORS.text, fontSize: 16, fontWeight: '600' }}>
              Offline Transaction Queue
            </Text>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: COLORS.text, fontSize: 24, fontWeight: '700' }}>
                {txQueueStats.queued}
              </Text>
              <Text style={{ color: COLORS.textTertiary, fontSize: 11 }}>Queued</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: COLORS.cyan, fontSize: 24, fontWeight: '700' }}>
                {txQueueStats.relaying}
              </Text>
              <Text style={{ color: COLORS.textTertiary, fontSize: 11 }}>Relaying</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: COLORS.primary, fontSize: 24, fontWeight: '700' }}>
                {txQueueStats.total - txQueueStats.failed - txQueueStats.expired}
              </Text>
              <Text style={{ color: COLORS.textTertiary, fontSize: 11 }}>Pending</Text>
            </View>
          </View>
        </LinearGradient>
      </Animated.View>

      {pendingTransactions.length === 0 ? (
        <EmptyState
          icon="swap-horizontal-outline"
          title="No pending transactions"
          subtitle="Offline transactions will appear here"
        />
      ) : (
        pendingTransactions.map((tx, index) => (
          <Animated.View key={tx.id} entering={FadeInDown.delay(100 + index * 50)}>
            <View
              style={{
                backgroundColor: COLORS.surfaceSecondary,
                borderRadius: 16,
                padding: 14,
                marginBottom: 10,
                borderWidth: 1,
                borderColor: COLORS.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: COLORS.purple + '20',
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginRight: 12,
                  }}
                >
                  <Ionicons
                    name={tx.type === 'SWAP' ? 'swap-horizontal' : 'arrow-up'}
                    size={18}
                    color={COLORS.purple}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: COLORS.text, fontSize: 15, fontWeight: '600' }}>
                    {tx.amount} {tx.currency}
                  </Text>
                  <Text style={{ color: COLORS.textTertiary, fontSize: 12 }}>
                    {tx.type} • {tx.status}
                  </Text>
                </View>
                <View
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    backgroundColor:
                      tx.status === 'CONFIRMED' ? COLORS.primary + '20' :
                      tx.status === 'FAILED' ? '#ef4444' + '20' :
                      COLORS.orange + '20',
                    borderRadius: 8,
                  }}
                >
                  <Text
                    style={{
                      color:
                        tx.status === 'CONFIRMED' ? COLORS.primary :
                        tx.status === 'FAILED' ? '#ef4444' :
                        COLORS.orange,
                      fontSize: 10,
                      fontWeight: '600',
                    }}
                  >
                    {tx.relayCount > 0 ? `${tx.relayCount} hops` : tx.status}
                  </Text>
                </View>
              </View>
            </View>
          </Animated.View>
        ))
      )}
    </View>
  );

  // Render Classic Mode content
  const renderClassicContent = () => {
    switch (classicTab) {
      case 'chats':
        return conversations.length === 0 ? (
          <EmptyState
            icon="chatbubbles-outline"
            title="No conversations"
            subtitle="Add contacts to start encrypted messaging"
          />
        ) : (
          conversations.map((conv, index) => (
            <Animated.View key={conv.contactId} entering={FadeInDown.delay(100 + index * 50)}>
              <TouchableOpacity
                onPress={() => handleContactPress(conv.contactId)}
                activeOpacity={0.7}
                style={styles.listItem}
              >
                <View style={[styles.avatar, { backgroundColor: COLORS.purple + '20' }]}>
                  <Text style={[styles.avatarText, { color: COLORS.purple }]}>
                    {conv.contact.alias.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.itemContent}>
                  <View style={styles.itemHeader}>
                    <Text style={styles.itemTitle}>{conv.contact.alias}</Text>
                    <Text style={styles.itemTime}>
                      {conv.lastMessage ? formatLastSeen(conv.lastMessage.timestamp) : ''}
                    </Text>
                  </View>
                  <View style={styles.itemSubheader}>
                    <Text style={styles.itemSubtitle} numberOfLines={1}>
                      {conv.lastMessage?.content || formatAddress(conv.contact.address)}
                    </Text>
                    {conv.unreadCount > 0 && (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{conv.unreadCount}</Text>
                      </View>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            </Animated.View>
          ))
        );

      case 'contacts':
        return contacts.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title="No contacts"
            subtitle="Add contacts by Solana address"
          />
        ) : (
          contacts.map((contact, index) => (
            <Animated.View key={contact.id} entering={FadeInDown.delay(100 + index * 50)}>
              <TouchableOpacity
                onPress={() => handleContactPress(contact.id)}
                activeOpacity={0.7}
                style={styles.listItem}
              >
                <View style={[styles.avatar, { backgroundColor: COLORS.primary + '20' }]}>
                  <Text style={[styles.avatarText, { color: COLORS.primary }]}>
                    {contact.alias.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.itemContent}>
                  <Text style={styles.itemTitle}>{contact.alias}</Text>
                  <Text style={styles.itemAddress}>{formatAddress(contact.address, 6)}</Text>
                </View>
                {contact.isFavorite && (
                  <Ionicons name="star" size={16} color={COLORS.primary} />
                )}
              </TouchableOpacity>
            </Animated.View>
          ))
        );

      case 'requests':
        return pendingPayments.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="No pending requests"
            subtitle="Payment requests will appear here"
          />
        ) : (
          pendingPayments.map((request, index) => (
            <Animated.View key={request.id} entering={FadeInDown.delay(100 + index * 50)}>
              <View style={styles.requestItem}>
                <View style={[styles.avatar, { backgroundColor: COLORS.cyan + '20' }]}>
                  <Ionicons name="arrow-down" size={20} color={COLORS.cyan} />
                </View>
                <View style={styles.itemContent}>
                  <Text style={styles.itemTitle}>
                    {request.amount} {request.currency}
                  </Text>
                  <Text style={styles.itemSubtitle}>{request.memo || 'No memo'}</Text>
                  <Text style={styles.itemAddress}>From: {formatAddress(request.fromAddress, 6)}</Text>
                </View>
                <View style={styles.requestActions}>
                  <TouchableOpacity style={[styles.requestBtn, styles.requestBtnPay]}>
                    <Ionicons name="checkmark" size={18} color="#000" />
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.requestBtn, styles.requestBtnDecline]}>
                    <Ionicons name="close" size={18} color={COLORS.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
            </Animated.View>
          ))
        );
    }
  };

  // Render Mesh Mode content
  const renderMeshContent = () => {
    switch (meshTab) {
      case 'zones':
        return (
          <View>
            {renderMeshStats()}
            {renderZoneCard(MeshZone.ALPHA, peersByZone[MeshZone.ALPHA])}
            {renderZoneCard(MeshZone.BETA, peersByZone[MeshZone.BETA])}
            {renderZoneCard(MeshZone.GAMMA, peersByZone[MeshZone.GAMMA])}
            {renderZoneCard(MeshZone.RELAY, peersByZone[MeshZone.RELAY])}
          </View>
        );

      case 'peers':
        return isScanning && nearbyPeers.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.cyan} />
            <Text style={styles.loadingText}>Scanning for nearby devices...</Text>
          </View>
        ) : nearbyPeers.length === 0 ? (
          <EmptyState
            icon="radio-outline"
            title="No peers nearby"
            subtitle="Pull down to scan for P-01 users"
          />
        ) : (
          nearbyPeers.map((peer, index) => renderPeerItem(peer, index))
        );

      case 'queue':
        return renderTxQueue();
    }
  };

  const isLoading = !contactsInitialized || !meshInitialized;

  if (isLoading) {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <ActivityIndicator size="large" color={COLORS.cyan} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={['rgba(0, 209, 255, 0.04)', 'rgba(153, 69, 255, 0.02)', 'transparent']}
        style={styles.gradient}
      />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerTop}>
          <View style={styles.headerTitle}>
            <Ionicons
              name={mode === 'classic' ? 'lock-closed' : 'radio'}
              size={24}
              color={mode === 'classic' ? COLORS.purple : COLORS.cyan}
            />
            <Text style={styles.title}>
              {mode === 'classic' ? 'ENCRYPTED' : 'MESH NETWORK'}
            </Text>
          </View>

          <View style={styles.headerActions}>
            {mode === 'mesh' && (
              <TouchableOpacity onPress={toggleBroadcast} style={styles.broadcastBtn}>
                <View style={[styles.broadcastDot, isBroadcasting && styles.broadcastDotActive]} />
                <Text style={[styles.broadcastText, isBroadcasting && styles.broadcastTextActive]}>
                  {isBroadcasting ? 'ON AIR' : 'HIDDEN'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => router.push('/(main)/(social)/settings')}
              style={styles.settingsBtn}
            >
              <Ionicons name="settings-outline" size={20} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Mode Switcher */}
        <View style={styles.modeSwitcher}>
          <TouchableOpacity
            onPress={() => switchMode('classic')}
            style={[styles.modeBtn, mode === 'classic' && styles.modeBtnActive]}
          >
            <Ionicons
              name="wallet-outline"
              size={18}
              color={mode === 'classic' ? COLORS.purple : COLORS.textTertiary}
            />
            <Text style={[styles.modeBtnText, mode === 'classic' && { color: COLORS.purple }]}>
              Solana
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => switchMode('mesh')}
            style={[styles.modeBtn, mode === 'mesh' && styles.modeBtnMeshActive]}
          >
            <Ionicons
              name="bluetooth-outline"
              size={18}
              color={mode === 'mesh' ? COLORS.cyan : COLORS.textTertiary}
            />
            <Text style={[styles.modeBtnText, mode === 'mesh' && { color: COLORS.cyan }]}>
              Bluetooth
            </Text>
          </TouchableOpacity>
        </View>

        {/* Tabs with animated indicator */}
        <View style={styles.tabs}>
          {mode === 'classic' ? (
            <>
              {CLASSIC_TABS.map((tab, index) => (
                <TouchableOpacity
                  key={tab}
                  onPress={() => scrollToClassicTab(index)}
                  style={styles.tab}
                >
                  <Text style={[styles.tabText, classicTab === tab && { color: COLORS.purple }]}>
                    {tab === 'chats' ? 'Chats' : tab === 'contacts' ? 'Contacts' : 'Requests'}
                    {tab === 'requests' && pendingPayments.length > 0 && (
                      <Text style={{ color: COLORS.cyan }}> ({pendingPayments.length})</Text>
                    )}
                  </Text>
                </TouchableOpacity>
              ))}
              {/* Animated indicator */}
              <Animated.View style={[styles.tabIndicator, styles.tabIndicatorClassic, classicIndicatorStyle]} />
            </>
          ) : (
            <>
              {MESH_TABS.map((tab, index) => (
                <TouchableOpacity
                  key={tab}
                  onPress={() => scrollToMeshTab(index)}
                  style={styles.tab}
                >
                  <Text style={[styles.tabText, meshTab === tab && { color: COLORS.cyan }]}>
                    {tab === 'zones' ? 'Zones' : tab === 'peers' ? 'Peers' : 'Queue'}
                    {tab === 'queue' && txQueueStats.total > 0 && (
                      <Text style={{ color: COLORS.orange }}> ({txQueueStats.total})</Text>
                    )}
                  </Text>
                </TouchableOpacity>
              ))}
              {/* Animated indicator */}
              <Animated.View style={[styles.tabIndicator, styles.tabIndicatorMesh, meshIndicatorStyle]} />
            </>
          )}
        </View>
      </View>

      {/* Swipeable Content */}
      {mode === 'mesh' ? (
        <PagerView
          ref={meshPagerRef}
          style={styles.content}
          initialPage={0}
          onPageScroll={handleMeshPageScroll}
          onPageSelected={handleMeshPageSelected}
        >
          {/* Zones Tab */}
          <View key="zones" style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl refreshing={isScanning} onRefresh={handleRefresh} tintColor={COLORS.cyan} />
              }
            >
              {renderMeshStats()}
              {renderZoneCard(MeshZone.ALPHA, peersByZone[MeshZone.ALPHA])}
              {renderZoneCard(MeshZone.BETA, peersByZone[MeshZone.BETA])}
              {renderZoneCard(MeshZone.GAMMA, peersByZone[MeshZone.GAMMA])}
              {renderZoneCard(MeshZone.RELAY, peersByZone[MeshZone.RELAY])}
            </ScrollView>
          </View>

          {/* Peers Tab */}
          <View key="peers" style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl refreshing={isScanning} onRefresh={handleRefresh} tintColor={COLORS.cyan} />
              }
            >
              {isScanning && nearbyPeers.length === 0 ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color={COLORS.cyan} />
                  <Text style={styles.loadingText}>Scanning for nearby devices...</Text>
                </View>
              ) : nearbyPeers.length === 0 ? (
                <EmptyState icon="radio-outline" title="No peers nearby" subtitle="Pull down to scan for P-01 users" />
              ) : (
                nearbyPeers.map((peer, index) => renderPeerItem(peer, index))
              )}
            </ScrollView>
          </View>

          {/* Queue Tab */}
          <View key="queue" style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }}
              showsVerticalScrollIndicator={false}
            >
              {renderTxQueue()}
            </ScrollView>
          </View>
        </PagerView>
      ) : (
        <PagerView
          ref={classicPagerRef}
          style={styles.content}
          initialPage={0}
          onPageScroll={handleClassicPageScroll}
          onPageSelected={handleClassicPageSelected}
        >
          {/* Chats Tab */}
          <View key="chats" style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl refreshing={false} onRefresh={handleRefresh} tintColor={COLORS.purple} />
              }
            >
              {conversations.length === 0 ? (
                <EmptyState icon="chatbubbles-outline" title="No conversations" subtitle="Add contacts to start encrypted messaging" />
              ) : (
                conversations.map((conv, index) => (
                  <Animated.View key={conv.contactId} entering={FadeInDown.delay(100 + index * 50)}>
                    <TouchableOpacity onPress={() => handleContactPress(conv.contactId)} activeOpacity={0.7} style={styles.listItem}>
                      <View style={[styles.avatar, { backgroundColor: COLORS.purple + '20' }]}>
                        <Text style={[styles.avatarText, { color: COLORS.purple }]}>{conv.contact.alias.charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={styles.itemContent}>
                        <View style={styles.itemHeader}>
                          <Text style={styles.itemTitle}>{conv.contact.alias}</Text>
                          <Text style={styles.itemTime}>{conv.lastMessage ? formatLastSeen(conv.lastMessage.timestamp) : ''}</Text>
                        </View>
                        <View style={styles.itemSubheader}>
                          <Text style={styles.itemSubtitle} numberOfLines={1}>{conv.lastMessage?.content || formatAddress(conv.contact.address)}</Text>
                          {conv.unreadCount > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{conv.unreadCount}</Text></View>}
                        </View>
                      </View>
                    </TouchableOpacity>
                  </Animated.View>
                ))
              )}
            </ScrollView>
          </View>

          {/* Contacts Tab */}
          <View key="contacts" style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }}
              showsVerticalScrollIndicator={false}
            >
              {contacts.length === 0 ? (
                <EmptyState icon="people-outline" title="No contacts" subtitle="Add contacts by Solana address" />
              ) : (
                contacts.map((contact, index) => (
                  <Animated.View key={contact.id} entering={FadeInDown.delay(100 + index * 50)}>
                    <TouchableOpacity onPress={() => handleContactPress(contact.id)} activeOpacity={0.7} style={styles.listItem}>
                      {/* Avatar with P-01 indicator */}
                      <View style={{ position: 'relative' }}>
                        <View style={[
                          styles.avatar,
                          { backgroundColor: contact.isP01User ? COLORS.primary + '20' : COLORS.orange + '20' }
                        ]}>
                          <Text style={[
                            styles.avatarText,
                            { color: contact.isP01User ? COLORS.primary : COLORS.orange }
                          ]}>
                            {contact.alias.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        {/* P-01 badge */}
                        {contact.isP01User && (
                          <View style={styles.p01Badge}>
                            <Ionicons name="shield-checkmark" size={12} color="#000" />
                          </View>
                        )}
                      </View>
                      <View style={styles.itemContent}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Text style={styles.itemTitle}>{contact.alias}</Text>
                          {/* User type badge */}
                          <View style={[
                            styles.userTypeBadge,
                            { backgroundColor: contact.isP01User ? COLORS.primary + '20' : COLORS.orange + '20' }
                          ]}>
                            <Text style={[
                              styles.userTypeBadgeText,
                              { color: contact.isP01User ? COLORS.primary : COLORS.orange }
                            ]}>
                              {contact.isP01User ? 'P-01' : 'Wallet'}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.itemAddress}>{formatAddress(contact.address, 6)}</Text>
                        {/* Capabilities indicator */}
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons
                              name="chatbubble"
                              size={12}
                              color={contact.canMessage ? COLORS.primary : COLORS.textTertiary}
                            />
                            <Text style={{
                              fontSize: 10,
                              color: contact.canMessage ? COLORS.textSecondary : COLORS.textTertiary,
                            }}>
                              {contact.canMessage ? 'Chat' : 'No chat'}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <Ionicons name="wallet" size={12} color={COLORS.primary} />
                            <Text style={{ fontSize: 10, color: COLORS.textSecondary }}>Crypto</Text>
                          </View>
                        </View>
                      </View>
                      {contact.isFavorite && <Ionicons name="star" size={16} color={COLORS.primary} />}
                    </TouchableOpacity>
                  </Animated.View>
                ))
              )}
            </ScrollView>
          </View>

          {/* Requests Tab */}
          <View key="requests" style={{ flex: 1 }}>
            <ScrollView
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }}
              showsVerticalScrollIndicator={false}
            >
              {pendingPayments.length === 0 ? (
                <EmptyState icon="receipt-outline" title="No pending requests" subtitle="Payment requests will appear here" />
              ) : (
                pendingPayments.map((request, index) => (
                  <Animated.View key={request.id} entering={FadeInDown.delay(100 + index * 50)}>
                    <View style={styles.requestItem}>
                      <View style={[styles.avatar, { backgroundColor: COLORS.cyan + '20' }]}>
                        <Ionicons name="arrow-down" size={20} color={COLORS.cyan} />
                      </View>
                      <View style={styles.itemContent}>
                        <Text style={styles.itemTitle}>{request.amount} {request.currency}</Text>
                        <Text style={styles.itemSubtitle}>{request.memo || 'No memo'}</Text>
                        <Text style={styles.itemAddress}>From: {formatAddress(request.fromAddress, 6)}</Text>
                      </View>
                      <View style={styles.requestActions}>
                        <TouchableOpacity style={[styles.requestBtn, styles.requestBtnPay]}>
                          <Ionicons name="checkmark" size={18} color="#000" />
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.requestBtn, styles.requestBtnDecline]}>
                          <Ionicons name="close" size={18} color={COLORS.textSecondary} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </Animated.View>
                ))
              )}
            </ScrollView>
          </View>
        </PagerView>
      )}

      {/* FAB Group for Mesh Mode */}
      {mode === 'mesh' ? (
        <View style={[styles.fabGroup, { bottom: insets.bottom + 90 }]}>
          {/* QR Code Button */}
          <TouchableOpacity
            onPress={() => {
              if (Platform.OS !== 'web') {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }
              router.push('/(main)/(social)/qr-share');
            }}
            style={styles.fabSmall}
          >
            <View style={[styles.fabSmallInner, { backgroundColor: COLORS.purple + '30' }]}>
              <Ionicons name="qr-code" size={22} color={COLORS.purple} />
            </View>
          </TouchableOpacity>

          {/* Scan Button */}
          <TouchableOpacity
            onPress={() => {
              if (Platform.OS !== 'web') {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }
              router.push('/(main)/(social)/qr-scan');
            }}
            style={styles.fabSmall}
          >
            <View style={[styles.fabSmallInner, { backgroundColor: COLORS.cyan + '30' }]}>
              <Ionicons name="scan" size={22} color={COLORS.cyan} />
            </View>
          </TouchableOpacity>

          {/* Refresh/Search Button */}
          <TouchableOpacity
            onPress={handleRefresh}
            style={styles.fab}
          >
            <LinearGradient
              colors={[COLORS.cyan, COLORS.purple]}
              style={styles.fabGradient}
            >
              {isScanning ? (
                <ActivityIndicator size="small" color="#000" />
              ) : (
                <Ionicons name="radio" size={24} color="#000" />
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          onPress={() => router.push('/(main)/(social)/add-contact')}
          style={[styles.fabSingle, { bottom: insets.bottom + 90 }]}
        >
          <LinearGradient
            colors={[COLORS.purple, COLORS.cyan]}
            style={styles.fabGradient}
          >
            <Ionicons name="person-add" size={24} color="#000" />
          </LinearGradient>
        </TouchableOpacity>
      )}

      {/* Proximity Bump Modal */}
      <ProximityBump
        visible={proximity.showBumpModal}
        peer={proximity.detectedPeer ? {
          id: proximity.detectedPeer.id,
          alias: proximity.detectedPeer.alias,
          address: proximity.detectedPeer.publicKey,
          distance: proximity.detectedPeer.distance,
          rssi: proximity.detectedPeer.rssi,
        } : null}
        onClose={dismissProximityBump}
        onConnect={async () => {
          if (proximity.detectedPeer) {
            await sendConnectionRequest(proximity.detectedPeer.id);
          }
        }}
        onSendMessage={() => {
          if (proximity.detectedPeer) {
            dismissProximityBump();
            router.push({
              pathname: '/(main)/(social)/chat',
              params: { peerId: proximity.detectedPeer.id, peerAlias: proximity.detectedPeer.alias },
            });
          }
        }}
        onSendCrypto={() => {
          if (proximity.detectedPeer) {
            dismissProximityBump();
            router.push({
              pathname: '/(main)/(wallet)/send',
              params: { toAddress: proximity.detectedPeer.publicKey },
            });
          }
        }}
        onSharePhoto={() => {
          // Future: implement photo sharing
          dismissProximityBump();
        }}
        isConnected={proximity.detectedPeer?.isConnected || false}
      />
    </View>
  );
}

// Empty state component
function EmptyState({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon as any} size={40} color={COLORS.textTertiary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtitle}>{subtitle}</Text>
    </View>
  );
}

const styles = {
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  } as const,
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
  } as const,
  gradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 350,
  } as const,
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  } as const,
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  } as const,
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
  } as const,
  title: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginLeft: 8,
    letterSpacing: 1,
  } as const,
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as const,
  broadcastBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  } as const,
  broadcastDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.textTertiary,
    marginRight: 6,
  } as const,
  broadcastDotActive: {
    backgroundColor: COLORS.primary,
  } as const,
  broadcastText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  } as const,
  broadcastTextActive: {
    color: COLORS.primary,
  } as const,
  settingsBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  } as const,
  modeSwitcher: {
    flexDirection: 'row',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  } as const,
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 8,
  } as const,
  modeBtnActive: {
    backgroundColor: COLORS.purple + '20',
  } as const,
  modeBtnMeshActive: {
    backgroundColor: COLORS.cyan + '20',
  } as const,
  modeBtnText: {
    color: COLORS.textTertiary,
    fontSize: 14,
    fontWeight: '600',
  } as const,
  tabs: {
    flexDirection: 'row',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 10,
    padding: 4,
    position: 'relative',
  } as const,
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  } as const,
  tabActive: {
    backgroundColor: COLORS.purple + '20',
  } as const,
  tabMeshActive: {
    backgroundColor: COLORS.cyan + '20',
  } as const,
  tabText: {
    color: COLORS.textTertiary,
    fontSize: 13,
    fontWeight: '600',
  } as const,
  content: {
    flex: 1,
  } as const,
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  } as const,
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  } as const,
  avatarText: {
    fontSize: 18,
    fontWeight: 'bold',
  } as const,
  itemContent: {
    flex: 1,
  } as const,
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as const,
  itemSubheader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  } as const,
  itemTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  } as const,
  itemSubtitle: {
    color: COLORS.textSecondary,
    fontSize: 13,
    flex: 1,
  } as const,
  itemAddress: {
    color: COLORS.textTertiary,
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  } as const,
  itemTime: {
    color: COLORS.textTertiary,
    fontSize: 11,
  } as const,
  badge: {
    backgroundColor: COLORS.purple,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    marginLeft: 8,
  } as const,
  badgeText: {
    color: '#000',
    fontSize: 11,
    fontWeight: 'bold',
  } as const,
  requestItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceSecondary,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.cyan + '30',
  } as const,
  requestActions: {
    flexDirection: 'row',
    gap: 8,
  } as const,
  requestBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  } as const,
  requestBtnPay: {
    backgroundColor: COLORS.primary,
  } as const,
  requestBtnDecline: {
    backgroundColor: COLORS.surfaceTertiary,
  } as const,
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  } as const,
  loadingText: {
    color: COLORS.textSecondary,
    marginTop: 16,
  } as const,
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  } as const,
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: COLORS.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  } as const,
  emptyTitle: {
    color: COLORS.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  } as const,
  emptySubtitle: {
    color: COLORS.textTertiary,
    textAlign: 'center',
    marginTop: 8,
  } as const,
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
  } as const,
  fabGradient: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  } as const,
  fabGroup: {
    position: 'absolute',
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  } as const,
  fabSmall: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  } as const,
  fabSmallInner: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 22,
  } as const,
  fabSingle: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
  } as const,
  tabIndicator: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    height: 3,
    width: (Dimensions.get('window').width - 48) / 3,
    borderRadius: 2,
  } as const,
  tabIndicatorClassic: {
    backgroundColor: COLORS.purple,
  } as const,
  tabIndicatorMesh: {
    backgroundColor: COLORS.cyan,
  } as const,
  p01Badge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: COLORS.surfaceSecondary,
  } as const,
  userTypeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  } as const,
  userTypeBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  } as const,
};
