# SPECTER MULTI-AGENT SYNC FILE

> Ce fichier permet la synchronisation entre agents. Chaque agent doit le consulter et le mettre à jour.

## STATUS DES AGENTS

| Agent | Status | Progress | Last Update |
|-------|--------|----------|-------------|
| ORCHESTRATOR | 🟢 ACTIVE | 100% | Initializing |
| WEB | 🟡 PENDING | 0% | Waiting |
| MOBILE | 🟡 PENDING | 0% | Waiting |
| SDK | 🟡 PENDING | 0% | Waiting |
| ANCHOR | 🟡 PENDING | 0% | Waiting |
| DESIGN | 🟡 PENDING | 0% | Waiting |

## SHARED CONSTANTS

```typescript
// PROGRAM ID (à utiliser par tous les agents)
export const PROGRAM_ID = "SPEC1111111111111111111111111111111111111111";

// COLORS
export const COLORS = {
  green: '#00ff88',
  purple: '#8b5cf6',
  blue: '#3b82f6',
  orange: '#f59e0b',
  black: '#050505',
  surface: '#111111',
  border: '#2a2a2a'
};

// NETWORK
export const NETWORK = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com'
};
```

## DEPENDENCIES GRAPH

```
SDK ──────────────────┬──→ MOBILE
                      │
                      └──→ WEB

ANCHOR ──→ SDK

DESIGN ──┬──→ WEB
         └──→ MOBILE
```

## COMMUNICATION LOG

### [INIT] Orchestrator
- Structure monorepo créée
- Agents en cours de lancement...

---
