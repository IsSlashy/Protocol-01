/**
 * Protocol 01 Known Services Registry
 *
 * Registry of known services for auto-detection and enhanced UX.
 * This allows wallets to show familiar service branding and verify merchant identity.
 */

import type { MerchantCategory } from './types';

// ============ Service Info Type ============

/**
 * Information about a known service
 */
export interface ServiceInfo {
  /** Service display name */
  name: string;
  /** Service logo URL */
  logo: string;
  /** Service category */
  category: MerchantCategory;
  /** Service description */
  description?: string;
  /** Official website */
  website?: string;
  /** Whether this is a verified service */
  verified?: boolean;
  /** Common subscription amounts for this service */
  commonAmounts?: number[];
  /** Default token used by this service */
  defaultToken?: string;
}

// ============ Known Services Registry ============

/**
 * Registry of known services by domain
 * Used for auto-detection when merchants integrate Protocol 01
 */
export const KNOWN_SERVICES: Record<string, ServiceInfo> = {
  // ============ Streaming Services ============
  'netflix.com': {
    name: 'Netflix',
    logo: 'https://assets.nflxext.com/us/ffe/siteui/common/icons/nficon2016.png',
    category: 'streaming',
    description: 'Watch movies and TV shows',
    website: 'https://netflix.com',
    verified: true,
    commonAmounts: [6.99, 15.49, 22.99],
    defaultToken: 'USDC',
  },
  'disneyplus.com': {
    name: 'Disney+',
    logo: 'https://static-assets.bamgrid.com/product/disneyplus/favicons/favicon-196x196.png',
    category: 'streaming',
    description: 'Disney, Pixar, Marvel, Star Wars, and more',
    website: 'https://disneyplus.com',
    verified: true,
    commonAmounts: [7.99, 13.99, 19.99],
    defaultToken: 'USDC',
  },
  'hulu.com': {
    name: 'Hulu',
    logo: 'https://assetshuluimcom-a.akamaihd.net/h3o/icons/favicon.ico.png',
    category: 'streaming',
    description: 'Stream TV and movies',
    website: 'https://hulu.com',
    verified: true,
    commonAmounts: [7.99, 17.99],
    defaultToken: 'USDC',
  },
  'max.com': {
    name: 'Max',
    logo: 'https://play.max.com/favicon.ico',
    category: 'streaming',
    description: 'HBO, DC, Warner Bros, and more',
    website: 'https://max.com',
    verified: true,
    commonAmounts: [9.99, 15.99, 19.99],
    defaultToken: 'USDC',
  },
  'primevideo.com': {
    name: 'Prime Video',
    logo: 'https://m.media-amazon.com/images/G/01/digital/video/web/Logo-min.png',
    category: 'streaming',
    description: 'Movies, TV shows, and originals',
    website: 'https://primevideo.com',
    verified: true,
    commonAmounts: [8.99, 14.99],
    defaultToken: 'USDC',
  },
  'peacocktv.com': {
    name: 'Peacock',
    logo: 'https://www.peacocktv.com/favicon.ico',
    category: 'streaming',
    description: 'NBCUniversal streaming',
    website: 'https://peacocktv.com',
    verified: true,
    commonAmounts: [5.99, 11.99],
    defaultToken: 'USDC',
  },
  'paramountplus.com': {
    name: 'Paramount+',
    logo: 'https://www.paramountplus.com/favicon.ico',
    category: 'streaming',
    description: 'CBS, Paramount, and more',
    website: 'https://paramountplus.com',
    verified: true,
    commonAmounts: [5.99, 11.99],
    defaultToken: 'USDC',
  },
  'crunchyroll.com': {
    name: 'Crunchyroll',
    logo: 'https://www.crunchyroll.com/favicons/favicon-196x196.png',
    category: 'streaming',
    description: 'Anime streaming',
    website: 'https://crunchyroll.com',
    verified: true,
    commonAmounts: [7.99, 9.99, 14.99],
    defaultToken: 'USDC',
  },

  // ============ Music Services ============
  'spotify.com': {
    name: 'Spotify',
    logo: 'https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png',
    category: 'music',
    description: 'Music and podcast streaming',
    website: 'https://spotify.com',
    verified: true,
    commonAmounts: [10.99, 14.99, 16.99],
    defaultToken: 'USDC',
  },
  'music.apple.com': {
    name: 'Apple Music',
    logo: 'https://music.apple.com/favicon.ico',
    category: 'music',
    description: 'Millions of songs and your entire library',
    website: 'https://music.apple.com',
    verified: true,
    commonAmounts: [10.99, 16.99],
    defaultToken: 'USDC',
  },
  'tidal.com': {
    name: 'Tidal',
    logo: 'https://tidal.com/favicon.ico',
    category: 'music',
    description: 'High-fidelity music streaming',
    website: 'https://tidal.com',
    verified: true,
    commonAmounts: [10.99, 19.99],
    defaultToken: 'USDC',
  },
  'deezer.com': {
    name: 'Deezer',
    logo: 'https://www.deezer.com/favicon.ico',
    category: 'music',
    description: 'Music streaming',
    website: 'https://deezer.com',
    verified: true,
    commonAmounts: [10.99, 14.99],
    defaultToken: 'USDC',
  },
  'soundcloud.com': {
    name: 'SoundCloud',
    logo: 'https://soundcloud.com/favicon.ico',
    category: 'music',
    description: 'Discover and stream music',
    website: 'https://soundcloud.com',
    verified: true,
    commonAmounts: [4.99, 9.99],
    defaultToken: 'USDC',
  },

  // ============ AI Services ============
  'openai.com': {
    name: 'ChatGPT Plus',
    logo: 'https://cdn.oaistatic.com/assets/favicon-o20kmmos.svg',
    category: 'ai',
    description: 'Advanced AI assistant',
    website: 'https://openai.com',
    verified: true,
    commonAmounts: [20.00, 200.00],
    defaultToken: 'USDC',
  },
  'anthropic.com': {
    name: 'Claude Pro',
    logo: 'https://anthropic.com/favicon.ico',
    category: 'ai',
    description: 'AI assistant by Anthropic',
    website: 'https://anthropic.com',
    verified: true,
    commonAmounts: [20.00, 100.00],
    defaultToken: 'USDC',
  },
  'midjourney.com': {
    name: 'Midjourney',
    logo: 'https://www.midjourney.com/favicon.ico',
    category: 'ai',
    description: 'AI image generation',
    website: 'https://midjourney.com',
    verified: true,
    commonAmounts: [10.00, 30.00, 60.00, 120.00],
    defaultToken: 'USDC',
  },
  'perplexity.ai': {
    name: 'Perplexity Pro',
    logo: 'https://www.perplexity.ai/favicon.ico',
    category: 'ai',
    description: 'AI-powered search engine',
    website: 'https://perplexity.ai',
    verified: true,
    commonAmounts: [20.00, 200.00],
    defaultToken: 'USDC',
  },
  'github.com': {
    name: 'GitHub Copilot',
    logo: 'https://github.githubassets.com/favicons/favicon.png',
    category: 'ai',
    description: 'AI pair programmer',
    website: 'https://github.com/features/copilot',
    verified: true,
    commonAmounts: [10.00, 19.00],
    defaultToken: 'USDC',
  },
  'cursor.sh': {
    name: 'Cursor',
    logo: 'https://cursor.sh/favicon.ico',
    category: 'ai',
    description: 'AI-powered code editor',
    website: 'https://cursor.sh',
    verified: true,
    commonAmounts: [20.00, 40.00],
    defaultToken: 'USDC',
  },
  'replit.com': {
    name: 'Replit',
    logo: 'https://replit.com/public/icons/favicon-196.png',
    category: 'ai',
    description: 'AI-powered development platform',
    website: 'https://replit.com',
    verified: true,
    commonAmounts: [7.00, 20.00, 50.00],
    defaultToken: 'USDC',
  },
  'runway.ml': {
    name: 'Runway',
    logo: 'https://runway.ml/favicon.ico',
    category: 'ai',
    description: 'AI video generation and editing',
    website: 'https://runway.ml',
    verified: true,
    commonAmounts: [12.00, 28.00, 76.00],
    defaultToken: 'USDC',
  },
  'elevenlabs.io': {
    name: 'ElevenLabs',
    logo: 'https://elevenlabs.io/favicon.ico',
    category: 'ai',
    description: 'AI voice synthesis',
    website: 'https://elevenlabs.io',
    verified: true,
    commonAmounts: [5.00, 22.00, 99.00, 330.00],
    defaultToken: 'USDC',
  },

  // ============ Gaming Services ============
  'xbox.com': {
    name: 'Xbox Game Pass',
    logo: 'https://xbox.com/favicon.ico',
    category: 'gaming',
    description: 'Xbox gaming subscription',
    website: 'https://xbox.com/game-pass',
    verified: true,
    commonAmounts: [9.99, 14.99, 16.99],
    defaultToken: 'USDC',
  },
  'playstation.com': {
    name: 'PlayStation Plus',
    logo: 'https://www.playstation.com/favicon.ico',
    category: 'gaming',
    description: 'PlayStation gaming subscription',
    website: 'https://playstation.com',
    verified: true,
    commonAmounts: [9.99, 14.99, 17.99],
    defaultToken: 'USDC',
  },
  'ea.com': {
    name: 'EA Play',
    logo: 'https://www.ea.com/favicon.ico',
    category: 'gaming',
    description: 'EA gaming subscription',
    website: 'https://ea.com/ea-play',
    verified: true,
    commonAmounts: [4.99, 14.99],
    defaultToken: 'USDC',
  },
  'ubisoft.com': {
    name: 'Ubisoft+',
    logo: 'https://www.ubisoft.com/favicon.ico',
    category: 'gaming',
    description: 'Ubisoft gaming subscription',
    website: 'https://ubisoft.com',
    verified: true,
    commonAmounts: [14.99, 17.99],
    defaultToken: 'USDC',
  },
  'nvidia.com': {
    name: 'GeForce NOW',
    logo: 'https://www.nvidia.com/favicon.ico',
    category: 'gaming',
    description: 'Cloud gaming service',
    website: 'https://nvidia.com/geforce-now',
    verified: true,
    commonAmounts: [9.99, 19.99],
    defaultToken: 'USDC',
  },

  // ============ SaaS / Productivity ============
  'notion.so': {
    name: 'Notion',
    logo: 'https://www.notion.so/images/favicon.ico',
    category: 'saas',
    description: 'All-in-one workspace',
    website: 'https://notion.so',
    verified: true,
    commonAmounts: [8.00, 15.00],
    defaultToken: 'USDC',
  },
  'figma.com': {
    name: 'Figma',
    logo: 'https://static.figma.com/app/icon/1/favicon.png',
    category: 'saas',
    description: 'Collaborative design tool',
    website: 'https://figma.com',
    verified: true,
    commonAmounts: [12.00, 45.00, 75.00],
    defaultToken: 'USDC',
  },
  'slack.com': {
    name: 'Slack',
    logo: 'https://a.slack-edge.com/80588/marketing/img/meta/favicon-32.png',
    category: 'saas',
    description: 'Team communication',
    website: 'https://slack.com',
    verified: true,
    commonAmounts: [7.25, 12.50],
    defaultToken: 'USDC',
  },
  'zoom.us': {
    name: 'Zoom',
    logo: 'https://zoom.us/favicon.ico',
    category: 'saas',
    description: 'Video conferencing',
    website: 'https://zoom.us',
    verified: true,
    commonAmounts: [13.33, 18.32, 22.49],
    defaultToken: 'USDC',
  },
  'dropbox.com': {
    name: 'Dropbox',
    logo: 'https://cfl.dropboxstatic.com/static/images/favicon.ico',
    category: 'storage',
    description: 'Cloud storage',
    website: 'https://dropbox.com',
    verified: true,
    commonAmounts: [9.99, 16.58, 24.00],
    defaultToken: 'USDC',
  },
  'evernote.com': {
    name: 'Evernote',
    logo: 'https://evernote.com/favicon.ico',
    category: 'productivity',
    description: 'Note-taking app',
    website: 'https://evernote.com',
    verified: true,
    commonAmounts: [10.83, 14.17],
    defaultToken: 'USDC',
  },
  'linear.app': {
    name: 'Linear',
    logo: 'https://linear.app/favicon.ico',
    category: 'saas',
    description: 'Issue tracking for modern teams',
    website: 'https://linear.app',
    verified: true,
    commonAmounts: [8.00, 14.00],
    defaultToken: 'USDC',
  },
  'canva.com': {
    name: 'Canva',
    logo: 'https://www.canva.com/favicon.ico',
    category: 'saas',
    description: 'Graphic design platform',
    website: 'https://canva.com',
    verified: true,
    commonAmounts: [12.99, 14.99, 29.99],
    defaultToken: 'USDC',
  },
  'adobe.com': {
    name: 'Adobe Creative Cloud',
    logo: 'https://www.adobe.com/favicon.ico',
    category: 'saas',
    description: 'Creative software suite',
    website: 'https://adobe.com',
    verified: true,
    commonAmounts: [22.99, 54.99, 59.99],
    defaultToken: 'USDC',
  },
  '1password.com': {
    name: '1Password',
    logo: 'https://1password.com/favicon.ico',
    category: 'saas',
    description: 'Password manager',
    website: 'https://1password.com',
    verified: true,
    commonAmounts: [2.99, 4.99, 7.99],
    defaultToken: 'USDC',
  },
  'bitwarden.com': {
    name: 'Bitwarden',
    logo: 'https://bitwarden.com/favicon.ico',
    category: 'saas',
    description: 'Password manager',
    website: 'https://bitwarden.com',
    verified: true,
    commonAmounts: [0.83, 3.33, 6.00],
    defaultToken: 'USDC',
  },

  // ============ News & Media ============
  'nytimes.com': {
    name: 'The New York Times',
    logo: 'https://www.nytimes.com/vi-assets/static-assets/favicon-4bf96cb6a1093748bf5b3c429accb9b4.ico',
    category: 'news',
    description: 'News and journalism',
    website: 'https://nytimes.com',
    verified: true,
    commonAmounts: [4.25, 17.00, 25.00],
    defaultToken: 'USDC',
  },
  'wsj.com': {
    name: 'The Wall Street Journal',
    logo: 'https://www.wsj.com/favicon.ico',
    category: 'news',
    description: 'Business and financial news',
    website: 'https://wsj.com',
    verified: true,
    commonAmounts: [12.00, 38.99],
    defaultToken: 'USDC',
  },
  'economist.com': {
    name: 'The Economist',
    logo: 'https://www.economist.com/favicon.ico',
    category: 'news',
    description: 'International news and analysis',
    website: 'https://economist.com',
    verified: true,
    commonAmounts: [14.50, 29.00],
    defaultToken: 'USDC',
  },
  'medium.com': {
    name: 'Medium',
    logo: 'https://miro.medium.com/v2/1*m-R_BkNf1Qjr1YbyOIJY2w.png',
    category: 'news',
    description: 'Reading and writing platform',
    website: 'https://medium.com',
    verified: true,
    commonAmounts: [5.00, 50.00],
    defaultToken: 'USDC',
  },
  'substack.com': {
    name: 'Substack',
    logo: 'https://substack.com/favicon.ico',
    category: 'news',
    description: 'Newsletter platform',
    website: 'https://substack.com',
    verified: true,
    commonAmounts: [5.00, 10.00, 15.00],
    defaultToken: 'USDC',
  },

  // ============ Fitness & Health ============
  'strava.com': {
    name: 'Strava',
    logo: 'https://www.strava.com/favicon.ico',
    category: 'fitness',
    description: 'Social fitness network',
    website: 'https://strava.com',
    verified: true,
    commonAmounts: [11.99, 79.99],
    defaultToken: 'USDC',
  },
  'peloton.com': {
    name: 'Peloton',
    logo: 'https://www.peloton.com/favicon.ico',
    category: 'fitness',
    description: 'Connected fitness',
    website: 'https://peloton.com',
    verified: true,
    commonAmounts: [12.99, 24.00, 44.00],
    defaultToken: 'USDC',
  },
  'calm.com': {
    name: 'Calm',
    logo: 'https://www.calm.com/favicon.ico',
    category: 'fitness',
    description: 'Meditation and sleep',
    website: 'https://calm.com',
    verified: true,
    commonAmounts: [14.99, 69.99],
    defaultToken: 'USDC',
  },
  'headspace.com': {
    name: 'Headspace',
    logo: 'https://www.headspace.com/favicon.ico',
    category: 'fitness',
    description: 'Meditation and mindfulness',
    website: 'https://headspace.com',
    verified: true,
    commonAmounts: [12.99, 69.99],
    defaultToken: 'USDC',
  },

  // ============ VPN Services ============
  'nordvpn.com': {
    name: 'NordVPN',
    logo: 'https://nordvpn.com/favicon.ico',
    category: 'vpn',
    description: 'VPN service',
    website: 'https://nordvpn.com',
    verified: true,
    commonAmounts: [3.99, 4.99, 12.99],
    defaultToken: 'USDC',
  },
  'expressvpn.com': {
    name: 'ExpressVPN',
    logo: 'https://www.expressvpn.com/favicon.ico',
    category: 'vpn',
    description: 'VPN service',
    website: 'https://expressvpn.com',
    verified: true,
    commonAmounts: [6.67, 9.99, 12.95],
    defaultToken: 'USDC',
  },
  'mullvad.net': {
    name: 'Mullvad VPN',
    logo: 'https://mullvad.net/favicon.ico',
    category: 'vpn',
    description: 'Privacy-focused VPN',
    website: 'https://mullvad.net',
    verified: true,
    commonAmounts: [5.00],
    defaultToken: 'USDC',
  },
  'protonvpn.com': {
    name: 'Proton VPN',
    logo: 'https://protonvpn.com/favicon.ico',
    category: 'vpn',
    description: 'Secure VPN by Proton',
    website: 'https://protonvpn.com',
    verified: true,
    commonAmounts: [4.99, 9.99],
    defaultToken: 'USDC',
  },

  // ============ Cloud Services ============
  'aws.amazon.com': {
    name: 'Amazon Web Services',
    logo: 'https://a0.awsstatic.com/libra-css/images/site/fav/favicon.ico',
    category: 'cloud',
    description: 'Cloud computing platform',
    website: 'https://aws.amazon.com',
    verified: true,
    defaultToken: 'USDC',
  },
  'cloud.google.com': {
    name: 'Google Cloud',
    logo: 'https://cloud.google.com/favicon.ico',
    category: 'cloud',
    description: 'Cloud computing platform',
    website: 'https://cloud.google.com',
    verified: true,
    defaultToken: 'USDC',
  },
  'vercel.com': {
    name: 'Vercel',
    logo: 'https://vercel.com/favicon.ico',
    category: 'cloud',
    description: 'Frontend cloud platform',
    website: 'https://vercel.com',
    verified: true,
    commonAmounts: [20.00],
    defaultToken: 'USDC',
  },
  'netlify.com': {
    name: 'Netlify',
    logo: 'https://www.netlify.com/favicon.ico',
    category: 'cloud',
    description: 'Web development platform',
    website: 'https://netlify.com',
    verified: true,
    commonAmounts: [19.00, 99.00],
    defaultToken: 'USDC',
  },
  'railway.app': {
    name: 'Railway',
    logo: 'https://railway.app/favicon.ico',
    category: 'cloud',
    description: 'Infrastructure platform',
    website: 'https://railway.app',
    verified: true,
    commonAmounts: [5.00, 20.00],
    defaultToken: 'USDC',
  },

  // ============ Education ============
  'skillshare.com': {
    name: 'Skillshare',
    logo: 'https://www.skillshare.com/favicon.ico',
    category: 'education',
    description: 'Online learning community',
    website: 'https://skillshare.com',
    verified: true,
    commonAmounts: [13.99, 32.00],
    defaultToken: 'USDC',
  },
  'masterclass.com': {
    name: 'MasterClass',
    logo: 'https://www.masterclass.com/favicon.ico',
    category: 'education',
    description: 'Online classes from experts',
    website: 'https://masterclass.com',
    verified: true,
    commonAmounts: [10.00, 15.00, 20.00],
    defaultToken: 'USDC',
  },
  'coursera.org': {
    name: 'Coursera',
    logo: 'https://www.coursera.org/favicon.ico',
    category: 'education',
    description: 'Online courses and degrees',
    website: 'https://coursera.org',
    verified: true,
    commonAmounts: [49.00, 59.00],
    defaultToken: 'USDC',
  },
  'udemy.com': {
    name: 'Udemy',
    logo: 'https://www.udemy.com/favicon.ico',
    category: 'education',
    description: 'Online courses',
    website: 'https://udemy.com',
    verified: true,
    commonAmounts: [16.58, 29.99],
    defaultToken: 'USDC',
  },
  'duolingo.com': {
    name: 'Duolingo',
    logo: 'https://www.duolingo.com/favicon.ico',
    category: 'education',
    description: 'Language learning',
    website: 'https://duolingo.com',
    verified: true,
    commonAmounts: [6.99, 12.99],
    defaultToken: 'USDC',
  },
};

// ============ Type Aliases ============

/** Alias for ServiceInfo */
export type RegisteredService = ServiceInfo;

/** Result of a service lookup */
export interface ServiceLookupResult {
  service: ServiceInfo | null;
  domain: string;
  verified: boolean;
}

/** Service registry class for looking up known services */
export class ServiceRegistry {
  static detect(origin: string): ServiceLookupResult {
    const domain = extractDomain(origin);
    const service = KNOWN_SERVICES[domain] ?? null;
    return { service, domain, verified: service?.verified === true };
  }

  static isVerified(origin: string): boolean {
    return isVerifiedService(origin);
  }

  static getByCategory(category: MerchantCategory): Array<[string, ServiceInfo]> {
    return getServicesByCategory(category);
  }

  static search(query: string): Array<[string, ServiceInfo]> {
    return searchServices(query);
  }
}

// ============ Detection Functions ============

/**
 * Extract domain from URL or origin
 * @param input - URL, origin, or domain string
 * @returns Normalized domain (e.g., "netflix.com")
 */
export function extractDomain(input: string): string {
  try {
    // Handle URLs
    if (input.includes('://')) {
      const url = new URL(input);
      input = url.hostname;
    }

    // Remove www. prefix
    input = input.replace(/^www\./, '');

    // Handle subdomains - keep only last two parts for common TLDs
    const parts = input.split('.');
    if (parts.length > 2) {
      // Check for compound TLDs like .co.uk
      const compoundTlds = ['co.uk', 'com.au', 'co.nz', 'com.br'];
      const lastTwo = parts.slice(-2).join('.');
      if (compoundTlds.includes(lastTwo)) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    }

    return input.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

/**
 * Detect service info from origin/URL
 * @param origin - Window origin, URL, or domain
 * @returns ServiceInfo if found, null otherwise
 */
export function detectService(origin: string): ServiceInfo | null {
  const domain = extractDomain(origin);
  return KNOWN_SERVICES[domain] ?? null;
}

/**
 * Check if a domain is a known verified service
 * @param origin - Window origin, URL, or domain
 * @returns true if the service is verified
 */
export function isVerifiedService(origin: string): boolean {
  const service = detectService(origin);
  return service?.verified === true;
}

/**
 * Get services by category
 * @param category - Service category to filter by
 * @returns Array of [domain, ServiceInfo] pairs
 */
export function getServicesByCategory(
  category: MerchantCategory
): Array<[string, ServiceInfo]> {
  return Object.entries(KNOWN_SERVICES).filter(
    ([, info]) => info.category === category
  );
}

/**
 * Search services by name
 * @param query - Search query
 * @returns Array of [domain, ServiceInfo] pairs matching the query
 */
export function searchServices(
  query: string
): Array<[string, ServiceInfo]> {
  const lowerQuery = query.toLowerCase();
  return Object.entries(KNOWN_SERVICES).filter(
    ([domain, info]) =>
      domain.includes(lowerQuery) ||
      info.name.toLowerCase().includes(lowerQuery) ||
      info.description?.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get all service categories
 * @returns Array of unique categories
 */
export function getCategories(): MerchantCategory[] {
  const categories = new Set<MerchantCategory>();
  for (const service of Object.values(KNOWN_SERVICES)) {
    categories.add(service.category);
  }
  return Array.from(categories).sort();
}

/**
 * Get count of services per category
 * @returns Map of category to count
 */
export function getCategoryCounts(): Map<MerchantCategory, number> {
  const counts = new Map<MerchantCategory, number>();
  for (const service of Object.values(KNOWN_SERVICES)) {
    counts.set(service.category, (counts.get(service.category) ?? 0) + 1);
  }
  return counts;
}
