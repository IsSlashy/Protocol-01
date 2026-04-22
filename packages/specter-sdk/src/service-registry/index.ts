/**
 * Service Registry — on-chain directory of subscription-accepting merchants.
 *
 * Any wallet can register as a merchant (Netflix, Spotify, self-hosted SaaS,
 * etc.) and all Protocol 01 clients pick up the entry automatically via
 * {@link fetchAllServices}. The protocol authority attests verified services
 * via {@link buildAttestServiceIx}.
 *
 * This module is framework-agnostic: every helper works with a plain
 * {@link Connection} and {@link PublicKey} and does not bundle a wallet
 * adapter. Merchant servers, CLIs, and the mobile app all consume it.
 */

export * from './account';
export * from './instructions';
export * from './pda';
export * from './client';
export { REGISTRY_PROGRAM_ID, REGISTRY_PROGRAM_IDS } from '../constants';
