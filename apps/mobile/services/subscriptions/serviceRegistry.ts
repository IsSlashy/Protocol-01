/**
 * Service Registry - Auto-detection for known subscription services
 *
 * Provides service branding, logos, and category information for
 * subscription services detected by domain or name matching.
 *
 * Mobile-optimized version for React Native
 */

// ============ Types ============

export interface ServiceInfo {
  id: string;
  name: string;
  logo: string; // URL to service logo (simple-icons CDN)
  category: ServiceCategory;
  color?: string; // Brand color for UI theming
  domains: string[]; // All domains this service uses
  description?: string;
  aliases?: string[]; // Alternative names for fuzzy matching
}

export type ServiceCategory =
  | 'streaming'
  | 'music'
  | 'ai'
  | 'gaming'
  | 'saas'
  | 'news'
  | 'fitness'
  | 'storage'
  | 'vpn'
  | 'education'
  | 'productivity'
  | 'communication'
  | 'other';

// ============ Category Configuration ============

export const CATEGORY_CONFIG: Record<ServiceCategory, { icon: string; color: string; label: string }> = {
  streaming: { icon: 'play-circle', color: '#E50914', label: 'Streaming' },
  music: { icon: 'musical-notes', color: '#1DB954', label: 'Music' },
  ai: { icon: 'sparkles', color: '#412991', label: 'AI Services' },
  gaming: { icon: 'game-controller', color: '#107C10', label: 'Gaming' },
  saas: { icon: 'briefcase', color: '#000000', label: 'SaaS' },
  news: { icon: 'newspaper', color: '#000000', label: 'News & Media' },
  fitness: { icon: 'fitness', color: '#FC4C02', label: 'Fitness' },
  storage: { icon: 'cloud', color: '#0061FF', label: 'Storage' },
  vpn: { icon: 'shield-checkmark', color: '#4687FF', label: 'VPN & Security' },
  education: { icon: 'school', color: '#5624D0', label: 'Education' },
  productivity: { icon: 'checkmark-circle', color: '#7B68EE', label: 'Productivity' },
  communication: { icon: 'chatbubbles', color: '#5865F2', label: 'Communication' },
  other: { icon: 'card', color: '#666666', label: 'Other' },
};

// ============ Service Registry ============

export const SERVICE_REGISTRY: Record<string, ServiceInfo> = {
  // === STREAMING ===
  'netflix': {
    id: 'netflix',
    name: 'Netflix',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/netflix.svg',
    category: 'streaming',
    color: '#E50914',
    domains: ['netflix.com', 'www.netflix.com'],
    aliases: ['netflx'],
  },
  'disney-plus': {
    id: 'disney-plus',
    name: 'Disney+',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/disneyplus.svg',
    category: 'streaming',
    color: '#113CCF',
    domains: ['disneyplus.com', 'www.disneyplus.com', 'disney.com'],
    aliases: ['disney plus', 'disneyplus', 'disney +'],
  },
  'hbo-max': {
    id: 'hbo-max',
    name: 'Max (HBO)',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/hbo.svg',
    category: 'streaming',
    color: '#5822B4',
    domains: ['max.com', 'hbomax.com', 'www.max.com', 'www.hbomax.com'],
    aliases: ['hbo max', 'hbomax', 'max', 'hbo'],
  },
  'prime-video': {
    id: 'prime-video',
    name: 'Prime Video',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/primevideo.svg',
    category: 'streaming',
    color: '#00A8E1',
    domains: ['primevideo.com', 'amazon.com/primevideo', 'www.primevideo.com'],
    aliases: ['amazon prime video', 'amazon video', 'prime'],
  },
  'hulu': {
    id: 'hulu',
    name: 'Hulu',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/hulu.svg',
    category: 'streaming',
    color: '#1CE783',
    domains: ['hulu.com', 'www.hulu.com'],
  },
  'crunchyroll': {
    id: 'crunchyroll',
    name: 'Crunchyroll',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/crunchyroll.svg',
    category: 'streaming',
    color: '#F47521',
    domains: ['crunchyroll.com', 'www.crunchyroll.com'],
    aliases: ['crunchy roll'],
  },
  'peacock': {
    id: 'peacock',
    name: 'Peacock',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/peacock.svg',
    category: 'streaming',
    color: '#000000',
    domains: ['peacocktv.com', 'www.peacocktv.com'],
    aliases: ['peacock tv'],
  },
  'paramount-plus': {
    id: 'paramount-plus',
    name: 'Paramount+',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/paramountplus.svg',
    category: 'streaming',
    color: '#0064FF',
    domains: ['paramountplus.com', 'www.paramountplus.com'],
    aliases: ['paramount plus', 'paramountplus', 'paramount +'],
  },
  'youtube-premium': {
    id: 'youtube-premium',
    name: 'YouTube Premium',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/youtube.svg',
    category: 'streaming',
    color: '#FF0000',
    domains: ['youtube.com', 'www.youtube.com'],
    aliases: ['yt premium', 'youtube'],
  },
  'twitch': {
    id: 'twitch',
    name: 'Twitch',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/twitch.svg',
    category: 'streaming',
    color: '#9146FF',
    domains: ['twitch.tv', 'www.twitch.tv'],
    aliases: ['twitch turbo', 'twitch subscription'],
  },

  // === MUSIC ===
  'spotify': {
    id: 'spotify',
    name: 'Spotify',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/spotify.svg',
    category: 'music',
    color: '#1DB954',
    domains: ['spotify.com', 'open.spotify.com', 'www.spotify.com'],
    aliases: ['spotify premium'],
  },
  'apple-music': {
    id: 'apple-music',
    name: 'Apple Music',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/applemusic.svg',
    category: 'music',
    color: '#FA243C',
    domains: ['music.apple.com', 'apple.com/apple-music'],
    aliases: ['applemusic', 'itunes music'],
  },
  'youtube-music': {
    id: 'youtube-music',
    name: 'YouTube Music',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/youtubemusic.svg',
    category: 'music',
    color: '#FF0000',
    domains: ['music.youtube.com'],
    aliases: ['yt music', 'youtubemusic'],
  },
  'tidal': {
    id: 'tidal',
    name: 'TIDAL',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/tidal.svg',
    category: 'music',
    color: '#000000',
    domains: ['tidal.com', 'www.tidal.com'],
  },
  'deezer': {
    id: 'deezer',
    name: 'Deezer',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/deezer.svg',
    category: 'music',
    color: '#FEAA2D',
    domains: ['deezer.com', 'www.deezer.com'],
  },
  'soundcloud': {
    id: 'soundcloud',
    name: 'SoundCloud',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/soundcloud.svg',
    category: 'music',
    color: '#FF5500',
    domains: ['soundcloud.com', 'www.soundcloud.com'],
    aliases: ['soundcloud go', 'soundcloud go+'],
  },
  'amazon-music': {
    id: 'amazon-music',
    name: 'Amazon Music',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/amazonmusic.svg',
    category: 'music',
    color: '#25D1DA',
    domains: ['music.amazon.com', 'amazon.com/music'],
    aliases: ['amazon music unlimited'],
  },

  // === AI SERVICES ===
  'openai': {
    id: 'openai',
    name: 'ChatGPT Plus',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/openai.svg',
    category: 'ai',
    color: '#412991',
    domains: ['openai.com', 'chat.openai.com', 'www.openai.com'],
    aliases: ['chatgpt', 'chat gpt', 'gpt plus', 'openai plus', 'chatgpt pro'],
  },
  'anthropic': {
    id: 'anthropic',
    name: 'Claude Pro',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/anthropic.svg',
    category: 'ai',
    color: '#D97757',
    domains: ['anthropic.com', 'claude.ai', 'www.anthropic.com'],
    aliases: ['claude', 'claude ai', 'anthropic claude'],
  },
  'midjourney': {
    id: 'midjourney',
    name: 'Midjourney',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/midjourney.svg',
    category: 'ai',
    color: '#000000',
    domains: ['midjourney.com', 'www.midjourney.com'],
    aliases: ['mid journey', 'mj'],
  },
  'github-copilot': {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/github.svg',
    category: 'ai',
    color: '#000000',
    domains: ['github.com/features/copilot', 'copilot.github.com'],
    aliases: ['copilot', 'gh copilot'],
  },
  'perplexity': {
    id: 'perplexity',
    name: 'Perplexity Pro',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/perplexity.svg',
    category: 'ai',
    color: '#20808D',
    domains: ['perplexity.ai', 'www.perplexity.ai'],
    aliases: ['perplexity ai'],
  },
  'runway': {
    id: 'runway',
    name: 'Runway',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/runwayml.svg',
    category: 'ai',
    color: '#000000',
    domains: ['runwayml.com', 'www.runwayml.com', 'runway.ml'],
    aliases: ['runwayml', 'runway ml'],
  },

  // === GAMING ===
  'xbox-gamepass': {
    id: 'xbox-gamepass',
    name: 'Xbox Game Pass',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/xbox.svg',
    category: 'gaming',
    color: '#107C10',
    domains: ['xbox.com', 'microsoft.com/xbox', 'www.xbox.com'],
    aliases: ['game pass', 'gamepass', 'xbox pass'],
  },
  'playstation-plus': {
    id: 'playstation-plus',
    name: 'PlayStation Plus',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/playstation.svg',
    category: 'gaming',
    color: '#003791',
    domains: ['playstation.com', 'www.playstation.com'],
    aliases: ['ps plus', 'psplus', 'ps+', 'playstation network'],
  },
  'nintendo-online': {
    id: 'nintendo-online',
    name: 'Nintendo Switch Online',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/nintendoswitch.svg',
    category: 'gaming',
    color: '#E60012',
    domains: ['nintendo.com', 'www.nintendo.com'],
    aliases: ['switch online', 'nso', 'nintendo online'],
  },
  'ea-play': {
    id: 'ea-play',
    name: 'EA Play',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/ea.svg',
    category: 'gaming',
    color: '#000000',
    domains: ['ea.com', 'www.ea.com'],
    aliases: ['ea access', 'electronic arts'],
  },
  'ubisoft-plus': {
    id: 'ubisoft-plus',
    name: 'Ubisoft+',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/ubisoft.svg',
    category: 'gaming',
    color: '#000000',
    domains: ['ubisoft.com', 'www.ubisoft.com'],
    aliases: ['ubisoft plus', 'ubisoft+'],
  },

  // === SAAS & PRODUCTIVITY ===
  'notion': {
    id: 'notion',
    name: 'Notion',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/notion.svg',
    category: 'saas',
    color: '#000000',
    domains: ['notion.so', 'notion.com', 'www.notion.so'],
    aliases: ['notion pro', 'notion team'],
  },
  'figma': {
    id: 'figma',
    name: 'Figma',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/figma.svg',
    category: 'saas',
    color: '#F24E1E',
    domains: ['figma.com', 'www.figma.com'],
    aliases: ['figma pro', 'figma organization'],
  },
  'slack': {
    id: 'slack',
    name: 'Slack',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/slack.svg',
    category: 'communication',
    color: '#4A154B',
    domains: ['slack.com', 'www.slack.com'],
    aliases: ['slack pro', 'slack business'],
  },
  'linear': {
    id: 'linear',
    name: 'Linear',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/linear.svg',
    category: 'productivity',
    color: '#5E6AD2',
    domains: ['linear.app', 'www.linear.app'],
  },
  'airtable': {
    id: 'airtable',
    name: 'Airtable',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/airtable.svg',
    category: 'productivity',
    color: '#18BFFF',
    domains: ['airtable.com', 'www.airtable.com'],
  },
  'canva': {
    id: 'canva',
    name: 'Canva Pro',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/canva.svg',
    category: 'saas',
    color: '#00C4CC',
    domains: ['canva.com', 'www.canva.com'],
    aliases: ['canva'],
  },
  'adobe-creative-cloud': {
    id: 'adobe-creative-cloud',
    name: 'Adobe Creative Cloud',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/adobecreativecloud.svg',
    category: 'saas',
    color: '#DA1F26',
    domains: ['adobe.com', 'creativecloud.adobe.com', 'www.adobe.com'],
    aliases: ['adobe cc', 'creative cloud', 'adobe'],
  },
  '1password': {
    id: '1password',
    name: '1Password',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/1password.svg',
    category: 'saas',
    color: '#0094F5',
    domains: ['1password.com', 'www.1password.com'],
    aliases: ['one password', 'onepassword'],
  },
  'lastpass': {
    id: 'lastpass',
    name: 'LastPass',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/lastpass.svg',
    category: 'saas',
    color: '#D32D27',
    domains: ['lastpass.com', 'www.lastpass.com'],
    aliases: ['last pass'],
  },
  'bitwarden': {
    id: 'bitwarden',
    name: 'Bitwarden',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/bitwarden.svg',
    category: 'saas',
    color: '#175DDC',
    domains: ['bitwarden.com', 'www.bitwarden.com'],
  },

  // === STORAGE ===
  'dropbox': {
    id: 'dropbox',
    name: 'Dropbox',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/dropbox.svg',
    category: 'storage',
    color: '#0061FF',
    domains: ['dropbox.com', 'www.dropbox.com'],
    aliases: ['dropbox plus', 'dropbox professional'],
  },
  'google-one': {
    id: 'google-one',
    name: 'Google One',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/google.svg',
    category: 'storage',
    color: '#4285F4',
    domains: ['one.google.com', 'www.google.com/one'],
    aliases: ['google drive', 'google storage'],
  },
  'icloud': {
    id: 'icloud',
    name: 'iCloud+',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/icloud.svg',
    category: 'storage',
    color: '#3693F3',
    domains: ['icloud.com', 'www.icloud.com'],
    aliases: ['icloud plus', 'apple icloud'],
  },
  'onedrive': {
    id: 'onedrive',
    name: 'OneDrive',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/microsoftonedrive.svg',
    category: 'storage',
    color: '#0078D4',
    domains: ['onedrive.live.com', 'onedrive.com'],
    aliases: ['microsoft onedrive'],
  },

  // === NEWS & MEDIA ===
  'nytimes': {
    id: 'nytimes',
    name: 'NY Times',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/nytimes.svg',
    category: 'news',
    color: '#000000',
    domains: ['nytimes.com', 'www.nytimes.com'],
    aliases: ['new york times', 'nyt'],
  },
  'medium': {
    id: 'medium',
    name: 'Medium',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/medium.svg',
    category: 'news',
    color: '#000000',
    domains: ['medium.com', 'www.medium.com'],
    aliases: ['medium membership'],
  },
  'wsj': {
    id: 'wsj',
    name: 'Wall Street Journal',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/wsj.svg',
    category: 'news',
    color: '#000000',
    domains: ['wsj.com', 'www.wsj.com'],
    aliases: ['wall street journal', 'wsj'],
  },
  'washington-post': {
    id: 'washington-post',
    name: 'Washington Post',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/washingtonpost.svg',
    category: 'news',
    color: '#000000',
    domains: ['washingtonpost.com', 'www.washingtonpost.com'],
    aliases: ['wapo'],
  },
  'economist': {
    id: 'economist',
    name: 'The Economist',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/theeconomist.svg',
    category: 'news',
    color: '#E3120B',
    domains: ['economist.com', 'www.economist.com'],
  },
  'substack': {
    id: 'substack',
    name: 'Substack',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/substack.svg',
    category: 'news',
    color: '#FF6719',
    domains: ['substack.com'],
    aliases: ['substack subscription'],
  },

  // === VPN & SECURITY ===
  'nordvpn': {
    id: 'nordvpn',
    name: 'NordVPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/nordvpn.svg',
    category: 'vpn',
    color: '#4687FF',
    domains: ['nordvpn.com', 'www.nordvpn.com'],
    aliases: ['nord vpn'],
  },
  'expressvpn': {
    id: 'expressvpn',
    name: 'ExpressVPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/expressvpn.svg',
    category: 'vpn',
    color: '#DA3940',
    domains: ['expressvpn.com', 'www.expressvpn.com'],
    aliases: ['express vpn'],
  },
  'surfshark': {
    id: 'surfshark',
    name: 'Surfshark',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/surfshark.svg',
    category: 'vpn',
    color: '#178BF1',
    domains: ['surfshark.com', 'www.surfshark.com'],
  },
  'protonvpn': {
    id: 'protonvpn',
    name: 'ProtonVPN',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/protonvpn.svg',
    category: 'vpn',
    color: '#66DEB1',
    domains: ['protonvpn.com', 'www.protonvpn.com'],
    aliases: ['proton vpn'],
  },

  // === FITNESS ===
  'strava': {
    id: 'strava',
    name: 'Strava',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/strava.svg',
    category: 'fitness',
    color: '#FC4C02',
    domains: ['strava.com', 'www.strava.com'],
    aliases: ['strava premium', 'strava summit'],
  },
  'peloton': {
    id: 'peloton',
    name: 'Peloton',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/peloton.svg',
    category: 'fitness',
    color: '#000000',
    domains: ['onepeloton.com', 'www.onepeloton.com'],
    aliases: ['peloton digital', 'peloton app'],
  },
  'fitbit': {
    id: 'fitbit',
    name: 'Fitbit Premium',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/fitbit.svg',
    category: 'fitness',
    color: '#00B0B9',
    domains: ['fitbit.com', 'www.fitbit.com'],
    aliases: ['fitbit'],
  },
  'myfitnesspal': {
    id: 'myfitnesspal',
    name: 'MyFitnessPal',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/myfitnesspal.svg',
    category: 'fitness',
    color: '#0066ED',
    domains: ['myfitnesspal.com', 'www.myfitnesspal.com'],
    aliases: ['my fitness pal', 'mfp'],
  },

  // === EDUCATION ===
  'coursera': {
    id: 'coursera',
    name: 'Coursera Plus',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/coursera.svg',
    category: 'education',
    color: '#0056D2',
    domains: ['coursera.org', 'www.coursera.org'],
    aliases: ['coursera'],
  },
  'udemy': {
    id: 'udemy',
    name: 'Udemy Business',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/udemy.svg',
    category: 'education',
    color: '#A435F0',
    domains: ['udemy.com', 'www.udemy.com'],
  },
  'skillshare': {
    id: 'skillshare',
    name: 'Skillshare',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/skillshare.svg',
    category: 'education',
    color: '#00FF84',
    domains: ['skillshare.com', 'www.skillshare.com'],
  },
  'masterclass': {
    id: 'masterclass',
    name: 'MasterClass',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/masterclass.svg',
    category: 'education',
    color: '#000000',
    domains: ['masterclass.com', 'www.masterclass.com'],
    aliases: ['master class'],
  },
  'duolingo': {
    id: 'duolingo',
    name: 'Duolingo Plus',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/duolingo.svg',
    category: 'education',
    color: '#58CC02',
    domains: ['duolingo.com', 'www.duolingo.com'],
    aliases: ['duolingo'],
  },

  // === COMMUNICATION ===
  'discord': {
    id: 'discord',
    name: 'Discord Nitro',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/discord.svg',
    category: 'communication',
    color: '#5865F2',
    domains: ['discord.com', 'discordapp.com'],
    aliases: ['discord', 'nitro'],
  },
  'zoom': {
    id: 'zoom',
    name: 'Zoom',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/zoom.svg',
    category: 'communication',
    color: '#0B5CFF',
    domains: ['zoom.us', 'zoom.com', 'www.zoom.us'],
    aliases: ['zoom pro', 'zoom meetings'],
  },
  'microsoft-365': {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/microsoft.svg',
    category: 'productivity',
    color: '#0078D4',
    domains: ['microsoft.com', 'office.com', '365.microsoft.com'],
    aliases: ['office 365', 'm365', 'microsoft office'],
  },
  'google-workspace': {
    id: 'google-workspace',
    name: 'Google Workspace',
    logo: 'https://cdn.jsdelivr.net/npm/simple-icons@v9/icons/google.svg',
    category: 'productivity',
    color: '#4285F4',
    domains: ['workspace.google.com', 'admin.google.com'],
    aliases: ['g suite', 'gsuite', 'google apps'],
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
    'netflix',
    'spotify',
    'openai',
    'disney-plus',
    'youtube-premium',
    'anthropic',
    'github-copilot',
    'notion',
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
