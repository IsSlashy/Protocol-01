/**
 * Unit tests for Protocol 01 service registry.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWN_SERVICES,
  extractDomain,
  detectService,
  isVerifiedService,
  getServicesByCategory,
  searchServices,
  getCategories,
  getCategoryCounts,
} from './registry';

// ============================================================
// extractDomain
// ============================================================

describe('extractDomain', () => {
  it('should extract domain from a full URL', () => {
    expect(extractDomain('https://www.netflix.com/browse')).toBe('netflix.com');
  });

  it('should extract domain from URL with https', () => {
    expect(extractDomain('https://netflix.com')).toBe('netflix.com');
  });

  it('should extract domain from URL with http', () => {
    expect(extractDomain('http://netflix.com')).toBe('netflix.com');
  });

  it('should strip www. prefix', () => {
    expect(extractDomain('www.netflix.com')).toBe('netflix.com');
  });

  it('should handle bare domain input', () => {
    expect(extractDomain('netflix.com')).toBe('netflix.com');
  });

  it('should strip subdomains to last two parts for common TLDs', () => {
    expect(extractDomain('api.netflix.com')).toBe('netflix.com');
    expect(extractDomain('app.staging.netflix.com')).toBe('netflix.com');
  });

  it('should handle compound TLDs like .co.uk', () => {
    expect(extractDomain('www.example.co.uk')).toBe('example.co.uk');
  });

  it('should handle compound TLDs like .com.au', () => {
    expect(extractDomain('subdomain.example.com.au')).toBe('example.com.au');
  });

  it('should handle compound TLDs like .co.nz', () => {
    expect(extractDomain('shop.example.co.nz')).toBe('example.co.nz');
  });

  it('should handle compound TLDs like .com.br', () => {
    expect(extractDomain('app.example.com.br')).toBe('example.com.br');
  });

  it('should lowercase the result', () => {
    expect(extractDomain('NETFLIX.COM')).toBe('netflix.com');
    expect(extractDomain('Netflix.Com')).toBe('netflix.com');
  });

  it('should handle URLs with ports', () => {
    expect(extractDomain('https://netflix.com:8080/path')).toBe('netflix.com');
  });

  it('should handle URLs with query params', () => {
    expect(extractDomain('https://netflix.com/path?q=1')).toBe('netflix.com');
  });

  it('should handle malformed input gracefully by lowercasing', () => {
    expect(extractDomain('SomeRandomString')).toBe('somerandomstring');
  });

  it('should handle origin-style input', () => {
    expect(extractDomain('https://www.spotify.com')).toBe('spotify.com');
  });
});

// ============================================================
// detectService
// ============================================================

describe('detectService', () => {
  it('should detect Netflix from its domain', () => {
    const service = detectService('netflix.com');
    expect(service).not.toBeNull();
    expect(service!.name).toBe('Netflix');
    expect(service!.category).toBe('streaming');
  });

  it('should detect Spotify from full URL', () => {
    const service = detectService('https://www.spotify.com/premium');
    expect(service).not.toBeNull();
    expect(service!.name).toBe('Spotify');
    expect(service!.category).toBe('music');
  });

  it('should detect OpenAI from subdomain URL', () => {
    const service = detectService('https://chat.openai.com');
    expect(service).not.toBeNull();
    expect(service!.name).toBe('ChatGPT Plus');
    expect(service!.category).toBe('ai');
  });

  it('should detect Disney+ from its domain', () => {
    const service = detectService('disneyplus.com');
    expect(service).not.toBeNull();
    expect(service!.name).toBe('Disney+');
  });

  it('should return null for unknown domains', () => {
    expect(detectService('unknownsite.com')).toBeNull();
    expect(detectService('example.org')).toBeNull();
  });

  it('should detect service from origin with www prefix', () => {
    const service = detectService('https://www.figma.com');
    expect(service).not.toBeNull();
    expect(service!.name).toBe('Figma');
  });

  it('should return verified=true for known services', () => {
    const service = detectService('netflix.com');
    expect(service!.verified).toBe(true);
  });

  it('should include common amounts for services that have them', () => {
    const service = detectService('netflix.com');
    expect(service!.commonAmounts).toBeDefined();
    expect(Array.isArray(service!.commonAmounts)).toBe(true);
    expect(service!.commonAmounts!.length).toBeGreaterThan(0);
  });

  it('should detect gaming services', () => {
    const xbox = detectService('xbox.com');
    expect(xbox).not.toBeNull();
    expect(xbox!.name).toBe('Xbox Game Pass');
    expect(xbox!.category).toBe('gaming');
  });

  it('should detect VPN services', () => {
    const nord = detectService('nordvpn.com');
    expect(nord).not.toBeNull();
    expect(nord!.name).toBe('NordVPN');
    expect(nord!.category).toBe('vpn');
  });

  it('should detect education services', () => {
    const duo = detectService('duolingo.com');
    expect(duo).not.toBeNull();
    expect(duo!.name).toBe('Duolingo');
    expect(duo!.category).toBe('education');
  });

  it('should detect cloud services', () => {
    const vercel = detectService('vercel.com');
    expect(vercel).not.toBeNull();
    expect(vercel!.name).toBe('Vercel');
    expect(vercel!.category).toBe('cloud');
  });
});

// ============================================================
// isVerifiedService
// ============================================================

describe('isVerifiedService', () => {
  it('should return true for known verified services', () => {
    expect(isVerifiedService('netflix.com')).toBe(true);
    expect(isVerifiedService('spotify.com')).toBe(true);
    expect(isVerifiedService('openai.com')).toBe(true);
  });

  it('should return true when given a full URL of a verified service', () => {
    expect(isVerifiedService('https://www.netflix.com/browse')).toBe(true);
  });

  it('should return false for unknown domains', () => {
    expect(isVerifiedService('unknownsite.com')).toBe(false);
    expect(isVerifiedService('malicious-site.xyz')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isVerifiedService('')).toBe(false);
  });
});

// ============================================================
// getServicesByCategory
// ============================================================

describe('getServicesByCategory', () => {
  it('should return streaming services', () => {
    const streaming = getServicesByCategory('streaming');
    expect(streaming.length).toBeGreaterThan(0);

    const domains = streaming.map(([domain]) => domain);
    expect(domains).toContain('netflix.com');
    expect(domains).toContain('disneyplus.com');
    expect(domains).toContain('hulu.com');
  });

  it('should return music services', () => {
    const music = getServicesByCategory('music');
    expect(music.length).toBeGreaterThan(0);

    const domains = music.map(([domain]) => domain);
    expect(domains).toContain('spotify.com');
  });

  it('should return AI services', () => {
    const ai = getServicesByCategory('ai');
    expect(ai.length).toBeGreaterThan(0);

    const domains = ai.map(([domain]) => domain);
    expect(domains).toContain('openai.com');
    expect(domains).toContain('anthropic.com');
  });

  it('should return each result as a [domain, ServiceInfo] tuple', () => {
    const streaming = getServicesByCategory('streaming');
    for (const [domain, info] of streaming) {
      expect(typeof domain).toBe('string');
      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('category', 'streaming');
      expect(info).toHaveProperty('logo');
    }
  });

  it('should return empty array for non-existent category', () => {
    // Using a type assertion since we're testing an invalid category
    const result = getServicesByCategory('nonexistent' as any);
    expect(result).toEqual([]);
  });

  it('should only return services matching the requested category', () => {
    const gaming = getServicesByCategory('gaming');
    for (const [, info] of gaming) {
      expect(info.category).toBe('gaming');
    }
  });

  it('should return VPN services', () => {
    const vpn = getServicesByCategory('vpn');
    expect(vpn.length).toBeGreaterThan(0);
    const domains = vpn.map(([d]) => d);
    expect(domains).toContain('nordvpn.com');
    expect(domains).toContain('mullvad.net');
  });

  it('should return education services', () => {
    const edu = getServicesByCategory('education');
    expect(edu.length).toBeGreaterThan(0);
    const domains = edu.map(([d]) => d);
    expect(domains).toContain('coursera.org');
    expect(domains).toContain('duolingo.com');
  });

  it('should return cloud services', () => {
    const cloud = getServicesByCategory('cloud');
    expect(cloud.length).toBeGreaterThan(0);
    const domains = cloud.map(([d]) => d);
    expect(domains).toContain('vercel.com');
    expect(domains).toContain('railway.app');
  });
});

// ============================================================
// searchServices
// ============================================================

describe('searchServices', () => {
  it('should find services by name', () => {
    const results = searchServices('Netflix');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]![0]).toBe('netflix.com');
  });

  it('should be case-insensitive', () => {
    const results = searchServices('netflix');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]![0]).toBe('netflix.com');
  });

  it('should find services by domain', () => {
    const results = searchServices('spotify.com');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(([d]) => d === 'spotify.com')).toBe(true);
  });

  it('should find services by description', () => {
    const results = searchServices('anime');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(([d]) => d === 'crunchyroll.com')).toBe(true);
  });

  it('should return empty array when no matches found', () => {
    const results = searchServices('zzzznonexistentzzzzz');
    expect(results).toEqual([]);
  });

  it('should find partial matches', () => {
    const results = searchServices('music');
    expect(results.length).toBeGreaterThan(0);
    // Should match Apple Music and others with "music" in name or description
  });

  it('should find services by partial domain', () => {
    const results = searchServices('vpn');
    expect(results.length).toBeGreaterThan(0);
    // Should match nordvpn.com, expressvpn.com, protonvpn.com
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('should return results as [domain, ServiceInfo] tuples', () => {
    const results = searchServices('Netflix');
    for (const [domain, info] of results) {
      expect(typeof domain).toBe('string');
      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('category');
    }
  });
});

// ============================================================
// getCategories
// ============================================================

describe('getCategories', () => {
  it('should return an array of unique categories', () => {
    const categories = getCategories();
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);

    // Check uniqueness
    const unique = new Set(categories);
    expect(unique.size).toBe(categories.length);
  });

  it('should include common categories', () => {
    const categories = getCategories();
    expect(categories).toContain('streaming');
    expect(categories).toContain('music');
    expect(categories).toContain('ai');
    expect(categories).toContain('gaming');
    expect(categories).toContain('vpn');
    expect(categories).toContain('education');
  });

  it('should return categories sorted alphabetically', () => {
    const categories = getCategories();
    const sorted = [...categories].sort();
    expect(categories).toEqual(sorted);
  });
});

// ============================================================
// getCategoryCounts
// ============================================================

describe('getCategoryCounts', () => {
  it('should return a Map of category counts', () => {
    const counts = getCategoryCounts();
    expect(counts instanceof Map).toBe(true);
    expect(counts.size).toBeGreaterThan(0);
  });

  it('should have positive counts for all categories', () => {
    const counts = getCategoryCounts();
    for (const [, count] of counts) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it('should have counts matching getServicesByCategory results', () => {
    const counts = getCategoryCounts();
    const streamingCount = counts.get('streaming');
    const streamingServices = getServicesByCategory('streaming');
    expect(streamingCount).toBe(streamingServices.length);
  });

  it('should have total count matching total number of known services', () => {
    const counts = getCategoryCounts();
    let total = 0;
    for (const [, count] of counts) {
      total += count;
    }
    expect(total).toBe(Object.keys(KNOWN_SERVICES).length);
  });

  it('should have streaming services in the registry', () => {
    const counts = getCategoryCounts();
    expect(counts.get('streaming')).toBeGreaterThan(0);
  });

  it('should have AI services in the registry', () => {
    const counts = getCategoryCounts();
    expect(counts.get('ai')).toBeGreaterThan(0);
  });
});

// ============================================================
// KNOWN_SERVICES data integrity
// ============================================================

describe('KNOWN_SERVICES data integrity', () => {
  it('should have all services with a name', () => {
    for (const [domain, info] of Object.entries(KNOWN_SERVICES)) {
      expect(info.name, `Service ${domain} missing name`).toBeTruthy();
    }
  });

  it('should have all services with a logo URL', () => {
    for (const [domain, info] of Object.entries(KNOWN_SERVICES)) {
      expect(info.logo, `Service ${domain} missing logo`).toBeTruthy();
    }
  });

  it('should have all services with a valid category', () => {
    const validCategories = [
      'streaming', 'music', 'ai', 'gaming', 'saas', 'news',
      'fitness', 'education', 'cloud', 'vpn', 'storage',
      'productivity', 'entertainment', 'finance', 'other',
    ];
    for (const [domain, info] of Object.entries(KNOWN_SERVICES)) {
      expect(
        validCategories,
        `Service ${domain} has invalid category: ${info.category}`
      ).toContain(info.category);
    }
  });

  it('should have USDC as default token for all services that specify one', () => {
    for (const [domain, info] of Object.entries(KNOWN_SERVICES)) {
      if (info.defaultToken) {
        expect(
          info.defaultToken,
          `Service ${domain} should have USDC as default token`
        ).toBe('USDC');
      }
    }
  });

  it('should have common amounts as arrays of positive numbers', () => {
    for (const [domain, info] of Object.entries(KNOWN_SERVICES)) {
      if (info.commonAmounts) {
        expect(
          Array.isArray(info.commonAmounts),
          `Service ${domain} commonAmounts should be an array`
        ).toBe(true);
        for (const amount of info.commonAmounts) {
          expect(
            amount,
            `Service ${domain} has non-positive common amount: ${amount}`
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('should have all verified services marked as true', () => {
    for (const [domain, info] of Object.entries(KNOWN_SERVICES)) {
      if (info.verified !== undefined) {
        expect(
          info.verified,
          `Service ${domain} has verified set to false`
        ).toBe(true);
      }
    }
  });
});
