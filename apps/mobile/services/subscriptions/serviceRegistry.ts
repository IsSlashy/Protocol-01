/**
 * Merchant catalogue - PRIVACY VENDORS ONLY.
 *
 * Replaced the streaming / music / gaming roster (Netflix, Disney+, Spotify,
 * YouTube Premium and 60 others) on 2026-08-04. A protocol whose whole
 * proposition is that nobody can see who pays whom should not demonstrate itself
 * on a catalogue of entertainment brands. The services below are the ones whose
 * customers have an actual reason to care that the payment is unlinkable.
 *
 * Two of them make the point better than any pitch could: Mullvad and Nym both
 * REMOVED recurring subscriptions on purpose rather than keep the payment trail
 * those require. The recurring leg they gave up is exactly what this protocol
 * is for.
 *
 * Every `logo` slug here was fetched from the CDN and checked for a 200 before
 * being written. The version moved from v9 to v13 because v9 carries no mark for
 * mullvad, kagi, startpage, simplelogin or cryptpad - eleven of the first
 * twenty-six slugs tried came back 404. Do not add an entry without checking its
 * slug resolves; a 404 here is a broken tile in the app.
 *
 * A few entries are donation funded rather than subscription funded (Tor,
 * Signal, Tails). They carry that in their description and are listed so name
 * and domain detection works when a user mentions them - not as a claim that
 * they sell a subscription this protocol can pay.
 */
export const SERVICE_REGISTRY: Record<string, ServiceInfo> = {
  // --- VPN and network privacy --------------------------------------------
  'mullvad': {
    id: 'mullvad',
    name: 'Mullvad VPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/mullvad.svg',
    category: 'vpn',
    color: '#294D73',
    domains: ['mullvad.net'],
    description: 'Flat rate, account numbers instead of identities',
    aliases: ['mullvad vpn'],
  },
  'proton-vpn': {
    id: 'proton-vpn',
    name: 'Proton VPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/protonvpn.svg',
    category: 'vpn',
    color: '#6D4AFF',
    domains: ['protonvpn.com', 'proton.me'],
    aliases: ['protonvpn'],
  },
  'ivpn': {
    id: 'ivpn',
    name: 'IVPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/wireguard.svg',
    category: 'vpn',
    color: '#88C0D0',
    domains: ['ivpn.net'],
    aliases: ['i vpn'],
  },
  'nordvpn': {
    id: 'nordvpn',
    name: 'NordVPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/nordvpn.svg',
    category: 'vpn',
    color: '#4687FF',
    domains: ['nordvpn.com'],
    aliases: ['nord vpn'],
  },
  'expressvpn': {
    id: 'expressvpn',
    name: 'ExpressVPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/expressvpn.svg',
    category: 'vpn',
    color: '#DA3940',
    domains: ['expressvpn.com'],
    aliases: ['express vpn'],
  },
  'pia': {
    id: 'pia',
    name: 'Private Internet Access',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/privateinternetaccess.svg',
    category: 'vpn',
    color: '#60C60A',
    domains: ['privateinternetaccess.com'],
    aliases: ['pia'],
  },
  'adguard': {
    id: 'adguard',
    name: 'AdGuard',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/adguard.svg',
    category: 'vpn',
    color: '#68BC71',
    domains: ['adguard.com'],
    aliases: ['ad guard'],
  },
  'tor': {
    id: 'tor',
    name: 'Tor Project',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/torproject.svg',
    category: 'vpn',
    color: '#7D4698',
    domains: ['torproject.org'],
    description: 'Donation funded, listed so detection works',
    aliases: ['tor'],
  },

  // --- Email, aliases and messaging ---------------------------------------
  'proton-mail': {
    id: 'proton-mail',
    name: 'Proton Mail',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/protonmail.svg',
    category: 'communication',
    color: '#6D4AFF',
    domains: ['proton.me', 'protonmail.com'],
    aliases: ['protonmail'],
  },
  'tuta': {
    id: 'tuta',
    name: 'Tuta',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/tutanota.svg',
    category: 'communication',
    color: '#A01E20',
    domains: ['tuta.com', 'tutanota.com'],
    aliases: ['tutanota'],
  },
  'simplelogin': {
    id: 'simplelogin',
    name: 'SimpleLogin',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/simplelogin.svg',
    category: 'communication',
    color: '#E44B4B',
    domains: ['simplelogin.io'],
    aliases: ['simple login'],
  },
  'signal': {
    id: 'signal',
    name: 'Signal',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/signal.svg',
    category: 'communication',
    color: '#3A76F0',
    domains: ['signal.org'],
    description: 'Donation funded, listed so detection works',
  },
  'threema': {
    id: 'threema',
    name: 'Threema',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/threema.svg',
    category: 'communication',
    color: '#000000',
    domains: ['threema.ch'],
  },
  'element': {
    id: 'element',
    name: 'Element',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/element.svg',
    category: 'communication',
    color: '#0DBD8B',
    domains: ['element.io'],
    aliases: ['matrix'],
  },
  'wire': {
    id: 'wire',
    name: 'Wire',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/wire.svg',
    category: 'communication',
    color: '#000000',
    domains: ['wire.com'],
  },
  'jitsi': {
    id: 'jitsi',
    name: 'Jitsi Meet',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/jitsi.svg',
    category: 'communication',
    color: '#1D76BA',
    domains: ['jitsi.org', 'meet.jit.si'],
  },

  // --- Password managers and secrets --------------------------------------
  'bitwarden': {
    id: 'bitwarden',
    name: 'Bitwarden',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/bitwarden.svg',
    category: 'productivity',
    color: '#175DDC',
    domains: ['bitwarden.com'],
    aliases: ['bit warden'],
  },
  '1password': {
    id: '1password',
    name: '1Password',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/1password.svg',
    category: 'productivity',
    color: '#0572EC',
    domains: ['1password.com'],
    aliases: ['one password'],
  },
  'keepassxc': {
    id: 'keepassxc',
    name: 'KeePassXC',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/keepassxc.svg',
    category: 'productivity',
    color: '#6CAC4D',
    domains: ['keepassxc.org'],
    aliases: ['keepass'],
  },
  'dashlane': {
    id: 'dashlane',
    name: 'Dashlane',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/dashlane.svg',
    category: 'productivity',
    color: '#0E353D',
    domains: ['dashlane.com'],
  },

  // --- Encrypted storage, notes and documents -----------------------------
  'proton-drive': {
    id: 'proton-drive',
    name: 'Proton Drive',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/protondrive.svg',
    category: 'storage',
    color: '#6D4AFF',
    domains: ['drive.proton.me'],
  },
  'nextcloud': {
    id: 'nextcloud',
    name: 'Nextcloud',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/nextcloud.svg',
    category: 'storage',
    color: '#0082C9',
    domains: ['nextcloud.com'],
  },
  'mega': {
    id: 'mega',
    name: 'MEGA',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/mega.svg',
    category: 'storage',
    color: '#D9272E',
    domains: ['mega.io', 'mega.nz'],
  },
  'cryptpad': {
    id: 'cryptpad',
    name: 'CryptPad',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/cryptpad.svg',
    category: 'productivity',
    color: '#0087FF',
    domains: ['cryptpad.fr'],
    aliases: ['crypt pad'],
  },
  'obsidian-sync': {
    id: 'obsidian-sync',
    name: 'Obsidian Sync',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/obsidian.svg',
    category: 'productivity',
    color: '#7C3AED',
    domains: ['obsidian.md'],
    aliases: ['obsidian'],
  },

  // --- Private search and browsing ----------------------------------------
  'kagi': {
    id: 'kagi',
    name: 'Kagi',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/kagi.svg',
    category: 'other',
    color: '#FFB319',
    domains: ['kagi.com'],
    description: 'Paid search, the clearest privacy subscription there is',
  },
  'startpage': {
    id: 'startpage',
    name: 'Startpage',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/startpage.svg',
    category: 'other',
    color: '#6573FF',
    domains: ['startpage.com'],
    aliases: ['start page'],
  },
  'duckduckgo': {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/duckduckgo.svg',
    category: 'other',
    color: '#DE5833',
    domains: ['duckduckgo.com'],
    aliases: ['ddg'],
  },
  'brave': {
    id: 'brave',
    name: 'Brave',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/brave.svg',
    category: 'other',
    color: '#FB542B',
    domains: ['brave.com'],
    aliases: ['brave browser'],
  },

  // --- Hardened systems ---------------------------------------------------
  'tails': {
    id: 'tails',
    name: 'Tails',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/tails.svg',
    category: 'other',
    color: '#56347C',
    domains: ['tails.net'],
    description: 'Donation funded, listed so detection works',
  },
  'qubes': {
    id: 'qubes',
    name: 'Qubes OS',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v13/icons/qubesos.svg',
    category: 'other',
    color: '#3874D8',
    domains: ['qubes-os.org'],
    aliases: ['qubes'],
  },
};

// ============ Detection Functions ============

/**
 * Extract domain from a URL or origin
 */
function extractDomain(urlOrOrigin: string): string {
  try {
    const url = new URL(urlOrOrigin);
    return url.hostname.replace(/^www\./, '');
  } catch {
    // If not a valid URL, treat as hostname directly
    return urlOrOrigin.replace(/^www\./, '').toLowerCase();
  }
}

/**
 * Normalize a string for comparison (lowercase, remove special chars)
 */
function normalizeString(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Calculate similarity score between two strings (0-1)
 * Uses a combination of substring matching and character overlap
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = normalizeString(str1);
  const s2 = normalizeString(str2);

  // Exact match
  if (s1 === s2) return 1;

  // One contains the other
  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.9;
  }

  // Character overlap (Jaccard-like)
  const chars1 = new Set(s1.split(''));
  const chars2 = new Set(s2.split(''));
  const intersection = [...chars1].filter(c => chars2.has(c)).length;
  const union = new Set([...chars1, ...chars2]).size;

  return intersection / union;
}

/**
 * Detect service from an origin URL (domain matching)
 */
export function detectServiceFromOrigin(origin: string): ServiceInfo | null {
  const domain = extractDomain(origin);

  for (const service of Object.values(SERVICE_REGISTRY)) {
    for (const serviceDomain of service.domains) {
      const normalizedServiceDomain = serviceDomain.replace(/^www\./, '').toLowerCase();

      // Exact match
      if (domain === normalizedServiceDomain) {
        return service;
      }

      // Subdomain match (e.g., chat.openai.com matches openai.com)
      if (domain.endsWith('.' + normalizedServiceDomain)) {
        return service;
      }

      // Service domain is subdomain (e.g., open.spotify.com)
      if (normalizedServiceDomain.includes(domain)) {
        return service;
      }
    }
  }

  return null;
}

/**
 * Detect service from merchant name (fuzzy matching)
 * Returns the best match if similarity is above threshold
 */
export function detectServiceFromName(name: string, threshold = 0.7): ServiceInfo | null {
  const normalizedInput = normalizeString(name);

  let bestMatch: ServiceInfo | null = null;
  let bestScore = threshold;

  for (const service of Object.values(SERVICE_REGISTRY)) {
    // Check service name
    const nameScore = calculateSimilarity(name, service.name);
    if (nameScore > bestScore) {
      bestScore = nameScore;
      bestMatch = service;
    }

    // Check service ID
    const idScore = calculateSimilarity(normalizedInput, service.id);
    if (idScore > bestScore) {
      bestScore = idScore;
      bestMatch = service;
    }

    // Check aliases
    if (service.aliases) {
      for (const alias of service.aliases) {
        const aliasScore = calculateSimilarity(name, alias);
        if (aliasScore > bestScore) {
          bestScore = aliasScore;
          bestMatch = service;
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Search services by query (returns all matches above threshold, sorted by relevance)
 */
export function searchServices(query: string, limit = 10): ServiceInfo[] {
  if (!query || query.length < 2) return [];

  const normalizedQuery = normalizeString(query);
  const results: { service: ServiceInfo; score: number }[] = [];

  for (const service of Object.values(SERVICE_REGISTRY)) {
    let maxScore = 0;

    // Check service name
    const nameScore = calculateSimilarity(query, service.name);
    maxScore = Math.max(maxScore, nameScore);

    // Check service ID
    const idScore = calculateSimilarity(normalizedQuery, service.id);
    maxScore = Math.max(maxScore, idScore);

    // Starts-with bonus for name or ID
    if (normalizeString(service.name).startsWith(normalizedQuery) ||
        service.id.startsWith(normalizedQuery)) {
      maxScore = Math.max(maxScore, 0.85);
    }

    // Check aliases
    if (service.aliases) {
      for (const alias of service.aliases) {
        const aliasScore = calculateSimilarity(query, alias);
        maxScore = Math.max(maxScore, aliasScore);

        if (normalizeString(alias).startsWith(normalizedQuery)) {
          maxScore = Math.max(maxScore, 0.85);
        }
      }
    }

    if (maxScore > 0.3) {
      results.push({ service, score: maxScore });
    }
  }

  // Sort by score descending and take top N
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.service);
}

/**
 * Get all services in a specific category
 */
export function getServicesByCategory(category: ServiceCategory): ServiceInfo[] {
  return Object.values(SERVICE_REGISTRY).filter(s => s.category === category);
}

/**
 * Get all available categories with service counts
 */
export function getAllCategories(): { category: ServiceCategory; count: number; config: typeof CATEGORY_CONFIG[ServiceCategory] }[] {
  const categories = new Map<ServiceCategory, number>();

  for (const service of Object.values(SERVICE_REGISTRY)) {
    categories.set(service.category, (categories.get(service.category) || 0) + 1);
  }

  return Array.from(categories.entries())
    .map(([category, count]) => ({
      category,
      count,
      config: CATEGORY_CONFIG[category],
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get category display info (icon name and color)
 */
export function getCategoryIcon(category: ServiceCategory): string {
  return CATEGORY_CONFIG[category]?.icon || CATEGORY_CONFIG.other.icon;
}

/**
 * Get category brand color
 */
export function getCategoryColor(category: ServiceCategory): string {
  return CATEGORY_CONFIG[category]?.color || CATEGORY_CONFIG.other.color;
}

/**
 * Get category label
 */
export function getCategoryLabel(category: ServiceCategory): string {
  return CATEGORY_CONFIG[category]?.label || 'Other';
}

/**
 * Get popular services (commonly used subscriptions)
 */
export function getPopularServices(): ServiceInfo[] {
  const popularIds = [
    'mullvad',
    'proton-vpn',
    'proton-mail',
    'bitwarden',
    'kagi',
    'tuta',
    'nextcloud',
    'obsidian-sync',
  ];

  return popularIds
    .map(id => SERVICE_REGISTRY[id])
    .filter((s): s is ServiceInfo => s !== undefined);
}

/**
 * Get a service by ID
 */
export function getServiceById(id: string): ServiceInfo | null {
  return SERVICE_REGISTRY[id] || null;
}

/**
 * Get all services as an array
 */
export function getAllServices(): ServiceInfo[] {
  return Object.values(SERVICE_REGISTRY);
}

/**
 * Create a generic service info for unknown services
 */
export function createGenericServiceInfo(name: string, origin?: string): Omit<ServiceInfo, 'id' | 'domains'> {
  return {
    name,
    logo: '', // Will use first letter fallback
    category: 'other',
    color: CATEGORY_CONFIG.other.color,
    description: origin ? `Subscription from ${origin}` : undefined,
  };
}
