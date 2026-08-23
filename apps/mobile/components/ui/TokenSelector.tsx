import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
  ActivityIndicator,
  Image,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontFamily, BorderRadius, Spacing } from '@/constants/theme';
import {
  JupiterToken,
  TOKEN_MINTS,
  searchTokens,
  getPopularTokens,
} from '@/services/jupiter';

interface TokenSelectorProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (token: JupiterToken) => void;
  excludeMint?: string;
}

// Hardcoded popular tokens — always available even if API fails
const HARDCODED_POPULAR: JupiterToken[] = [
  { address: TOKEN_MINTS.SOL, chainId: 101, decimals: 9, name: 'Solana', symbol: 'SOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' },
  { address: TOKEN_MINTS.USDC, chainId: 101, decimals: 6, name: 'USD Coin', symbol: 'USDC', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' },
  { address: TOKEN_MINTS.USDT, chainId: 101, decimals: 6, name: 'Tether USD', symbol: 'USDT', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.png' },
  { address: TOKEN_MINTS.JUP, chainId: 101, decimals: 6, name: 'Jupiter', symbol: 'JUP', logoURI: 'https://static.jup.ag/jup/icon.png' },
  { address: TOKEN_MINTS.BONK, chainId: 101, decimals: 5, name: 'Bonk', symbol: 'BONK', logoURI: 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I' },
  { address: TOKEN_MINTS.RAY, chainId: 101, decimals: 6, name: 'Raydium', symbol: 'RAY', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png' },
  { address: TOKEN_MINTS.WIF, chainId: 101, decimals: 6, name: 'dogwifhat', symbol: 'WIF', logoURI: 'https://bafkreibk3covs5ltyqxa272uodhculbr6kea6betiez6nscnzfjalm5foe.ipfs.nftstorage.link' },
  { address: TOKEN_MINTS.WBTC, chainId: 101, decimals: 8, name: 'Wrapped BTC (Portal)', symbol: 'WBTC' },
  { address: TOKEN_MINTS.WETH, chainId: 101, decimals: 8, name: 'Wrapped ETH (Portal)', symbol: 'WETH' },
  { address: TOKEN_MINTS.MSOL, chainId: 101, decimals: 9, name: 'Marinade staked SOL', symbol: 'mSOL', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So/logo.png' },
  { address: TOKEN_MINTS.JITOSOL, chainId: 101, decimals: 9, name: 'Jito Staked SOL', symbol: 'JitoSOL', logoURI: 'https://storage.googleapis.com/token-metadata/JitoSOL-256.png' },
  { address: TOKEN_MINTS.ORCA, chainId: 101, decimals: 6, name: 'Orca', symbol: 'ORCA', logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE/logo.png' },
  { address: TOKEN_MINTS.PYTH, chainId: 101, decimals: 6, name: 'Pyth Network', symbol: 'PYTH', logoURI: 'https://pyth.network/token.svg' },
  { address: TOKEN_MINTS.RENDER, chainId: 101, decimals: 8, name: 'Render Token', symbol: 'RENDER' },
  { address: TOKEN_MINTS.HNT, chainId: 101, decimals: 8, name: 'Helium', symbol: 'HNT' },
  { address: TOKEN_MINTS.PYUSD, chainId: 101, decimals: 6, name: 'PayPal USD', symbol: 'PYUSD' },
  { address: TOKEN_MINTS.EURC, chainId: 101, decimals: 6, name: 'Euro Coin', symbol: 'EURC' },
];

export default function TokenSelector({ visible, onClose, onSelect, excludeMint }: TokenSelectorProps) {
  const [query, setQuery] = useState('');
  const [apiTokens, setApiTokens] = useState<JupiterToken[]>([]);
  const [searchResults, setSearchResults] = useState<JupiterToken[]>([]);
  const [searching, setSearching] = useState(false);
  const [apiLoaded, setApiLoaded] = useState(false);

  // Load full token list from API in background (strict list ~300 tokens)
  useEffect(() => {
    if (!visible || apiLoaded) return;
    getPopularTokens()
      .then(tokens => {
        if (tokens.length > 0) setApiTokens(tokens);
        setApiLoaded(true);
      })
      .catch(() => setApiLoaded(true));
  }, [visible, apiLoaded]);

  // Search: filter from API list + hardcoded, with debounce
  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    const timeout = setTimeout(async () => {
      const lowerQuery = query.toLowerCase();
      // Search in API tokens first
      if (apiTokens.length > 0) {
        const results = apiTokens
          .filter(t =>
            t.symbol.toLowerCase().includes(lowerQuery) ||
            t.name.toLowerCase().includes(lowerQuery)
          )
          .slice(0, 30);
        setSearchResults(results);
      } else {
        // Fallback: search in hardcoded + try API
        const local = HARDCODED_POPULAR.filter(t =>
          t.symbol.toLowerCase().includes(lowerQuery) ||
          t.name.toLowerCase().includes(lowerQuery)
        );
        setSearchResults(local);
        try {
          const results = await searchTokens(query, 30);
          if (results.length > 0) setSearchResults(results);
        } catch { /* keep local results */ }
      }
      setSearching(false);
    }, 300);

    return () => clearTimeout(timeout);
  }, [query, apiTokens]);

  // Merge hardcoded with API data (API has better logos/info)
  const popularTokens = useMemo(() => {
    if (apiTokens.length === 0) return HARDCODED_POPULAR;
    // Replace hardcoded with API versions where available, keep order
    return HARDCODED_POPULAR.map(hc => {
      const apiVersion = apiTokens.find(t => t.address === hc.address);
      return apiVersion || hc;
    });
  }, [apiTokens]);

  const displayTokens = useMemo(() => {
    const tokens = query.trim() ? searchResults : popularTokens;
    return tokens.filter(t => t.address !== excludeMint);
  }, [query, searchResults, popularTokens, excludeMint]);

  const handleSelect = (token: JupiterToken) => {
    onSelect(token);
    setQuery('');
    onClose();
  };

  const renderToken = ({ item }: { item: JupiterToken }) => {
    const hardcoded = HARDCODED_POPULAR.find(t => t.address === item.address);
    const logoUri = item.logoURI || hardcoded?.logoURI;

    return (
      <TouchableOpacity
        style={styles.tokenRow}
        onPress={() => handleSelect(item)}
        activeOpacity={0.7}
      >
        <View style={styles.tokenIcon}>
          {logoUri ? (
            <Image source={{ uri: logoUri }} style={styles.tokenLogo} />
          ) : (
            <View style={styles.tokenLogoPlaceholder}>
              <Text style={styles.tokenLogoLetter}>
                {item.symbol.charAt(0)}
              </Text>
            </View>
          )}
        </View>
        <View style={styles.tokenInfo}>
          <Text style={styles.tokenSymbol}>{item.symbol}</Text>
          <Text style={styles.tokenName} numberOfLines={1}>
            {item.name}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Select Token</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={Colors.text} />
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={styles.searchContainer}>
          <Ionicons name="search" size={20} color={Colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name or symbol"
            placeholderTextColor={Colors.textTertiary}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={20} color={Colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>

        {/* Token List */}
        <FlatList
          data={displayTokens}
          keyExtractor={item => item.address}
          renderItem={renderToken}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons name="search-outline" size={40} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>
                {query ? 'No tokens found' : 'No tokens available'}
              </Text>
            </View>
          }
          ListHeaderComponent={
            !query.trim() ? (
              <Text style={styles.sectionTitle}>Popular tokens</Text>
            ) : searching ? (
              <View style={styles.searchingRow}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.searchingText}>Searching...</Text>
              </View>
            ) : null
          }
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: FontFamily.displayMedium,
    color: Colors.text,
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.md,
    marginHorizontal: Spacing.xl,
    marginVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    marginLeft: Spacing.sm,
    fontSize: 16,
    fontFamily: FontFamily.regular,
    color: Colors.text,
  },
  listContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing['4xl'],
  },
  // ⛔ Was uppercase with 1pt of tracking. A tracked-out all-caps label is the
  // house style being removed; a quiet sentence-case line does the same job.
  sectionTitle: {
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: Colors.textTertiary,
    marginBottom: Spacing.md,
    marginTop: Spacing.sm,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tokenIcon: {
    marginRight: Spacing.md,
  },
  tokenLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surface,
  },
  tokenLogoPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.surfaceTertiary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tokenLogoLetter: {
    fontSize: 18,
    fontFamily: FontFamily.semibold,
    color: Colors.textSecondary,
  },
  tokenInfo: {
    flex: 1,
  },
  tokenSymbol: {
    fontSize: 16,
    fontFamily: FontFamily.semibold,
    color: Colors.text,
  },
  tokenName: {
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: Spacing.md,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: Spacing['5xl'],
  },
  emptyText: {
    marginTop: Spacing.md,
    fontSize: 14,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  searchingText: {
    marginLeft: Spacing.sm,
    fontSize: 13,
    fontFamily: FontFamily.regular,
    color: Colors.textSecondary,
  },
});
