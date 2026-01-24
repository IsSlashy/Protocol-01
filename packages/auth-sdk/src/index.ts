/**
 * Protocol 01 Authentication SDK
 *
 * Enable "Login with Protocol 01" for your service.
 * Users scan a QR code and confirm with biometrics to authenticate
 * using their blockchain wallet and subscription status.
 *
 * @packageDocumentation
 */

// Types
export * from './types';

// Protocol utilities
export * from './protocol';

// Client SDK (for frontend/service providers)
export { P01AuthClient, type P01AuthClientConfig, type CreateSessionResult } from './client';

// Server SDK (for backend verification)
export { P01AuthServer, type P01AuthServerConfig } from './server';

// Default exports
export { default as P01AuthClient } from './client';
export { default as P01AuthServer } from './server';
