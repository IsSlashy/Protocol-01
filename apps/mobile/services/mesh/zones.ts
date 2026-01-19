/**
 * Protocol 01 - Mesh Zones
 *
 * Implements proximity-based mesh zones:
 * - Alpha Zone: Direct contact (< 3m) - Full trust, direct communication
 * - Beta Zone: Near proximity (3-15m) - Limited trust, may relay
 * - Gamma Zone: Extended range (15-50m) - Relay only, no direct trust
 * - Relay Zone: Network relay nodes that forward messages
 */

import { MeshPeer } from './bluetooth';

// Zone definitions
export enum MeshZone {
  ALPHA = 'ALPHA',   // < 3m - Direct, trusted
  BETA = 'BETA',     // 3-15m - Near, verified
  GAMMA = 'GAMMA',   // 15-50m - Extended, relay
  RELAY = 'RELAY',   // Network relays
  OFFLINE = 'OFFLINE', // Not connected
}

// Zone configuration
export const ZONE_CONFIG = {
  [MeshZone.ALPHA]: {
    name: 'Alpha',
    description: 'Direct contact zone',
    maxDistance: 3,
    rssiThreshold: -55,
    color: '#00ff88',    // Green
    trustLevel: 'HIGH',
    canTransact: true,
    canRelay: true,
    icon: 'radio',
  },
  [MeshZone.BETA]: {
    name: 'Beta',
    description: 'Near proximity zone',
    maxDistance: 15,
    rssiThreshold: -70,
    color: '#00D1FF',    // Cyan
    trustLevel: 'MEDIUM',
    canTransact: true,
    canRelay: true,
    icon: 'wifi',
  },
  [MeshZone.GAMMA]: {
    name: 'Gamma',
    description: 'Extended range zone',
    maxDistance: 50,
    rssiThreshold: -85,
    color: '#9945FF',    // Purple
    trustLevel: 'LOW',
    canTransact: false,
    canRelay: true,
    icon: 'globe-outline',
  },
  [MeshZone.RELAY]: {
    name: 'Relay',
    description: 'Network relay nodes',
    maxDistance: Infinity,
    rssiThreshold: -100,
    color: '#f59e0b',    // Orange
    trustLevel: 'RELAY',
    canTransact: false,
    canRelay: true,
    icon: 'git-network-outline',
  },
  [MeshZone.OFFLINE]: {
    name: 'Offline',
    description: 'Not connected',
    maxDistance: 0,
    rssiThreshold: -100,
    color: '#666666',    // Gray
    trustLevel: 'NONE',
    canTransact: false,
    canRelay: false,
    icon: 'cloud-offline-outline',
  },
};

// Determine zone from RSSI
export function getZoneFromRSSI(rssi: number): MeshZone {
  if (rssi >= ZONE_CONFIG[MeshZone.ALPHA].rssiThreshold) {
    return MeshZone.ALPHA;
  }
  if (rssi >= ZONE_CONFIG[MeshZone.BETA].rssiThreshold) {
    return MeshZone.BETA;
  }
  if (rssi >= ZONE_CONFIG[MeshZone.GAMMA].rssiThreshold) {
    return MeshZone.GAMMA;
  }
  return MeshZone.RELAY;
}

// Determine zone from distance (meters)
export function getZoneFromDistance(distance: number): MeshZone {
  if (distance <= ZONE_CONFIG[MeshZone.ALPHA].maxDistance) {
    return MeshZone.ALPHA;
  }
  if (distance <= ZONE_CONFIG[MeshZone.BETA].maxDistance) {
    return MeshZone.BETA;
  }
  if (distance <= ZONE_CONFIG[MeshZone.GAMMA].maxDistance) {
    return MeshZone.GAMMA;
  }
  return MeshZone.RELAY;
}

// Get zone info
export function getZoneInfo(zone: MeshZone) {
  return ZONE_CONFIG[zone];
}

// Get zone color
export function getZoneColor(zone: MeshZone): string {
  return ZONE_CONFIG[zone].color;
}

// Check if zone allows transactions
export function canTransactInZone(zone: MeshZone): boolean {
  return ZONE_CONFIG[zone].canTransact;
}

// Check if zone allows relay
export function canRelayInZone(zone: MeshZone): boolean {
  return ZONE_CONFIG[zone].canRelay;
}

// Group peers by zone
export function groupPeersByZone(peers: MeshPeer[]): Record<MeshZone, MeshPeer[]> {
  const groups: Record<MeshZone, MeshPeer[]> = {
    [MeshZone.ALPHA]: [],
    [MeshZone.BETA]: [],
    [MeshZone.GAMMA]: [],
    [MeshZone.RELAY]: [],
    [MeshZone.OFFLINE]: [],
  };

  for (const peer of peers) {
    const zone = getZoneFromRSSI(peer.rssi);
    groups[zone].push(peer);
  }

  return groups;
}

// Calculate mesh network stats
export function calculateMeshStats(peers: MeshPeer[]) {
  const groups = groupPeersByZone(peers);

  const totalPeers = peers.length;
  const connectedPeers = peers.filter(p => p.isConnected).length;
  const trustedPeers = peers.filter(p => p.isTrusted).length;

  const alphaCount = groups[MeshZone.ALPHA].length;
  const betaCount = groups[MeshZone.BETA].length;
  const gammaCount = groups[MeshZone.GAMMA].length;
  const relayCount = groups[MeshZone.RELAY].length;

  // Calculate mesh strength (0-100)
  let meshStrength = 0;
  meshStrength += Math.min(alphaCount * 30, 40);    // Alpha contributes most
  meshStrength += Math.min(betaCount * 15, 30);     // Beta contributes
  meshStrength += Math.min(gammaCount * 5, 15);     // Gamma contributes less
  meshStrength += Math.min(relayCount * 3, 15);     // Relay contributes least

  // Bonus for trusted peers
  meshStrength += Math.min(trustedPeers * 5, 10);

  return {
    totalPeers,
    connectedPeers,
    trustedPeers,
    alphaCount,
    betaCount,
    gammaCount,
    relayCount,
    meshStrength: Math.min(meshStrength, 100),
    canTransact: alphaCount > 0 || betaCount > 0,
    canRelay: totalPeers > 0,
  };
}

// Get best peer for transaction
export function getBestPeerForTransaction(peers: MeshPeer[]): MeshPeer | null {
  // Sort by zone priority (Alpha > Beta) and signal strength
  const eligiblePeers = peers
    .filter(p => {
      const zone = getZoneFromRSSI(p.rssi);
      return canTransactInZone(zone) && p.isConnected;
    })
    .sort((a, b) => {
      const zoneA = getZoneFromRSSI(a.rssi);
      const zoneB = getZoneFromRSSI(b.rssi);

      // Prioritize Alpha zone
      if (zoneA === MeshZone.ALPHA && zoneB !== MeshZone.ALPHA) return -1;
      if (zoneB === MeshZone.ALPHA && zoneA !== MeshZone.ALPHA) return 1;

      // Then by signal strength
      return b.rssi - a.rssi;
    });

  return eligiblePeers[0] || null;
}

// Get relay path for message
export function findRelayPath(
  fromPeer: string,
  toPeer: string,
  peers: MeshPeer[],
  maxHops: number = 5
): string[] | null {
  // Simple BFS to find relay path
  const visited = new Set<string>();
  const queue: { id: string; path: string[] }[] = [];

  queue.push({ id: fromPeer, path: [fromPeer] });
  visited.add(fromPeer);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.path.length > maxHops) continue;

    // Check if we reached destination
    if (current.id === toPeer) {
      return current.path;
    }

    // Find connected peers that can relay
    const connectedPeers = peers.filter(p =>
      p.isConnected &&
      !visited.has(p.id) &&
      canRelayInZone(getZoneFromRSSI(p.rssi))
    );

    for (const peer of connectedPeers) {
      visited.add(peer.id);
      queue.push({
        id: peer.id,
        path: [...current.path, peer.id],
      });
    }
  }

  return null; // No path found
}

// Zone visual indicator for UI
export interface ZoneIndicator {
  zone: MeshZone;
  label: string;
  color: string;
  peerCount: number;
  isActive: boolean;
}

export function getZoneIndicators(peers: MeshPeer[]): ZoneIndicator[] {
  const groups = groupPeersByZone(peers);

  return [
    {
      zone: MeshZone.ALPHA,
      label: 'α',
      color: ZONE_CONFIG[MeshZone.ALPHA].color,
      peerCount: groups[MeshZone.ALPHA].length,
      isActive: groups[MeshZone.ALPHA].length > 0,
    },
    {
      zone: MeshZone.BETA,
      label: 'β',
      color: ZONE_CONFIG[MeshZone.BETA].color,
      peerCount: groups[MeshZone.BETA].length,
      isActive: groups[MeshZone.BETA].length > 0,
    },
    {
      zone: MeshZone.GAMMA,
      label: 'γ',
      color: ZONE_CONFIG[MeshZone.GAMMA].color,
      peerCount: groups[MeshZone.GAMMA].length,
      isActive: groups[MeshZone.GAMMA].length > 0,
    },
    {
      zone: MeshZone.RELAY,
      label: 'R',
      color: ZONE_CONFIG[MeshZone.RELAY].color,
      peerCount: groups[MeshZone.RELAY].length,
      isActive: groups[MeshZone.RELAY].length > 0,
    },
  ];
}
