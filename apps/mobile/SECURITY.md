# Protocol 01 Mobile Security Documentation

This document outlines the security practices, architecture, and guidelines for the Protocol 01 mobile application.

## Table of Contents

1. [Security Architecture Overview](#security-architecture-overview)
2. [Key Storage](#key-storage)
3. [Authentication](#authentication)
4. [Encryption](#encryption)
5. [Network Security](#network-security)
6. [Data Handling](#data-handling)
7. [React Native Security](#react-native-security)
8. [Security Audit Findings](#security-audit-findings)
9. [Security Checklist](#security-checklist)
10. [Reporting Security Issues](#reporting-security-issues)

---

## Security Architecture Overview

Protocol 01 implements a multi-layered security approach:

```
+------------------------------------------+
|           Application Layer               |
|   (React Native / Expo Components)        |
+------------------------------------------+
|           Security Layer                  |
|   (Authentication, Encryption, Validation)|
+------------------------------------------+
|           Storage Layer                   |
|   (SecureStore, AsyncStorage)             |
+------------------------------------------+
|           Platform Layer                  |
|   (iOS Keychain / Android Keystore)       |
+------------------------------------------+
```

### Security Principles

1. **Defense in Depth**: Multiple layers of security controls
2. **Least Privilege**: Components access only necessary data
3. **Secure by Default**: Security features enabled by default
4. **Fail Securely**: Errors do not expose sensitive information

---

## Key Storage

### Sensitive Data Classification

| Data Type | Storage Location | Encryption |
|-----------|-----------------|------------|
| Mnemonic (Seed Phrase) | SecureStore | Platform-level |
| Private Key | SecureStore | Platform-level |
| Public Key | SecureStore | Platform-level |
| PIN Hash | SecureStore | SHA-256 + Salt |
| Encryption Keys | SecureStore | Platform-level |
| Session Tokens | SecureStore | Platform-level |
| User Preferences | AsyncStorage | None (non-sensitive) |
| Cache Data | AsyncStorage | None (non-sensitive) |

### SecureStore Configuration

```typescript
const SECURE_STORE_OPTIONS = {
  keychainService: 'protocol-01',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
```

**Security Properties:**
- Data accessible only when device is unlocked
- Data not included in device backups (iCloud/Google)
- Data tied to specific device (not transferable)

### Key Files

- `services/solana/wallet.ts` - Wallet key management
- `utils/storage/secure.ts` - Secure storage wrapper
- `utils/storage/keys.ts` - Storage key definitions

### Best Practices

1. **Never log sensitive data**: Private keys, mnemonics, and PINs must never appear in logs
2. **Clear memory after use**: Sensitive data should be zeroed out when no longer needed
3. **Use secure options**: Always specify `WHEN_UNLOCKED_THIS_DEVICE_ONLY` for sensitive data

---

## Authentication

### Biometric Authentication

Protocol 01 supports:
- Face ID (iOS)
- Touch ID (iOS)
- Fingerprint (Android)
- Facial Recognition (Android)

**Implementation**: `expo-local-authentication`

```typescript
// Authentication flow
const result = await LocalAuthentication.authenticateAsync({
  promptMessage: 'Authenticate to access wallet',
  fallbackLabel: 'Use PIN',
  disableDeviceFallback: false,
});
```

### PIN Authentication

- Minimum 4 digits, maximum 8 digits
- Weak pattern detection (sequential numbers, repeated digits)
- Rate limiting: 5 attempts before 5-minute lockout
- PIN stored as salted SHA-256 hash

### Key Files

- `hooks/useSecuritySettings.ts` - Security settings management
- `hooks/storage/useBiometrics.ts` - Biometric authentication
- `utils/validation/pin.ts` - PIN validation logic

### Timing Attack Prevention

Authentication comparisons use constant-time comparison:

```typescript
export function secureCompare(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const paddedA = a.padEnd(maxLen, '\0');
  const paddedB = b.padEnd(maxLen, '\0');

  let result = 0;
  for (let i = 0; i < maxLen; i++) {
    result |= paddedA.charCodeAt(i) ^ paddedB.charCodeAt(i);
  }
  result |= a.length ^ b.length;

  return result === 0;
}
```

---

## Encryption

### Encryption Algorithms

| Purpose | Algorithm | Key Size | Notes |
|---------|-----------|----------|-------|
| Key Derivation | Iterated SHA-256 | 256-bit | 100,000 iterations |
| Symmetric Encryption | AES-256-GCM | 256-bit | Authenticated encryption |
| Hashing | SHA-256/SHA-512 | - | expo-crypto |
| Key Exchange | X25519-like ECDH | 256-bit | Forward secrecy |

### Key Derivation

Password-based key derivation uses iterated hashing for security:

```typescript
export async function deriveKeyFromPassword(
  password: string,
  salt: string,
  iterations: number = 100000
): Promise<string> {
  let hash = `${salt}:${password}`;
  for (let i = 0; i < iterations; i++) {
    hash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      hash + salt + i.toString()
    );
  }
  return hash;
}
```

### SL3 Encryption (Message Encryption)

The SL3 (Security Level 3) encryption service provides:
- Ephemeral key pairs for forward secrecy
- ECDH-like key exchange
- AES-256-GCM encryption with authentication tags
- Session key management with 24-hour expiry

### Key Files

- `utils/crypto/encryption.ts` - Local data encryption
- `services/crypto/encryption.ts` - SL3 message encryption
- `utils/crypto/keys.ts` - Key derivation utilities

---

## Network Security

### HTTPS Requirements

All network communications use HTTPS:
- RPC endpoints: `https://api.devnet.solana.com`
- Price API: `https://api.coingecko.com`
- Token list: `https://token.jup.ag`

**Exception**: Local development endpoints (localhost) use HTTP

### RPC Security

```typescript
const RPC_ENDPOINTS: Record<SolanaCluster, string[]> = {
  'devnet': ['https://api.devnet.solana.com'],
  'mainnet-beta': ['https://api.mainnet-beta.solana.com'],
  'testnet': ['https://api.testnet.solana.com'],
};
```

### API Key Management

- API keys stored in SecureStore (not AsyncStorage)
- Keys never logged or included in error messages
- Keys transmitted only over HTTPS

### Key Files

- `services/solana/connection.ts` - RPC connection management
- `services/ai/agent.ts` - AI provider configuration

---

## Data Handling

### Clipboard Security

Sensitive data copied to clipboard is automatically cleared:

```typescript
// Auto-clear clipboard after 60 seconds
setTimeout(async () => {
  const currentClipboard = await Clipboard.getStringAsync();
  if (currentClipboard === sensitiveData) {
    await Clipboard.setStringAsync('');
  }
}, 60000);
```

### Screenshot Protection

When enabled, screenshots are blocked:

```typescript
if (settings.blockScreenshots) {
  await ScreenCapture.preventScreenCaptureAsync();
}
```

### Data Clearing on Logout

The `deleteWallet` function securely clears all sensitive data:

```typescript
export async function deleteWallet(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEYS.MNEMONIC);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.PRIVATE_KEY);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.PUBLIC_KEY);
  await SecureStore.deleteItemAsync(STORAGE_KEYS.WALLET_EXISTS);
}
```

### Input Validation

All user inputs are validated:

| Input Type | Validation |
|------------|------------|
| Mnemonic | Word count, BIP39 checksum, wordlist membership |
| Solana Address | Base58 format, 32-44 characters |
| Amount | Numeric, positive, within balance |
| PIN | 4-8 digits, not weak pattern |

### Key Files

- `utils/validation/address.ts` - Address validation
- `utils/validation/amount.ts` - Amount validation
- `utils/validation/pin.ts` - PIN validation
- `utils/validation/seedPhrase.ts` - Mnemonic validation

---

## React Native Security

### Hermes Considerations

Protocol 01 uses Hermes for performance. Security considerations:
- Bytecode is obfuscated but not encrypted
- Sensitive strings should not be hardcoded
- Runtime protection depends on platform security

### Secure Storage

Use `expo-secure-store` instead of `AsyncStorage` for sensitive data:

```typescript
// CORRECT - Secure storage
await SecureStore.setItemAsync('p01_mnemonic', mnemonic, {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});

// WRONG - Not secure
await AsyncStorage.setItem('p01_mnemonic', mnemonic);
```

### Deep Link Security

Deep links (`p01://`) should be validated:

```typescript
// Validate deep link parameters before use
function handleDeepLink(url: string) {
  const parsed = parseURL(url);

  // Validate address parameter
  if (parsed.address && !isValidAddress(parsed.address)) {
    throw new Error('Invalid address in deep link');
  }

  // Validate amount parameter
  if (parsed.amount && !isValidAmount(parsed.amount)) {
    throw new Error('Invalid amount in deep link');
  }
}
```

### Debug Mode

Debug features are disabled in production:

```typescript
export const FEATURES = {
  debugMode: __DEV__ ?? false,
};
```

---

## Security Audit Findings

### Audit Date: 2026-01-19

### Critical Issues Fixed

1. **Encryption Keys in AsyncStorage**
   - **Issue**: Encryption keys were stored in AsyncStorage (unencrypted)
   - **Fix**: Migrated to SecureStore with proper keychain options
   - **File**: `services/crypto/encryption.ts`

2. **Weak Key Derivation**
   - **Issue**: Single hash iteration for password-based key derivation
   - **Fix**: Implemented 100,000 iteration key stretching
   - **File**: `utils/crypto/encryption.ts`

### High Issues Fixed

3. **Private Key in Signature Computation**
   - **Issue**: Raw private key concatenated in signature
   - **Fix**: Use hashed/derived key material only
   - **File**: `services/mesh/offline.ts`

4. **Timing Attack Vulnerability**
   - **Issue**: Early-exit string comparison revealed length
   - **Fix**: Constant-time comparison with padding
   - **File**: `utils/crypto/encryption.ts`

### Medium Issues Fixed

5. **Clipboard Not Cleared**
   - **Issue**: Seed phrase remained in clipboard indefinitely
   - **Fix**: Auto-clear after 60 seconds
   - **File**: `app/(onboarding)/backup.tsx`

6. **Insufficient Input Validation**
   - **Issue**: Mnemonic import lacked comprehensive validation
   - **Fix**: Added word count, character, and checksum validation
   - **File**: `services/solana/wallet.ts`

### Low Issues (Recommendations)

7. **Console Logging**
   - **Recommendation**: Remove or minimize console.log in production
   - **Status**: Logs do not contain sensitive data

8. **HTTP Endpoints**
   - **Note**: localhost endpoints use HTTP (acceptable for local development)
   - **Status**: Production endpoints use HTTPS only

---

## Security Checklist

### Before Release

- [ ] All sensitive data stored in SecureStore (not AsyncStorage)
- [ ] No hardcoded secrets or API keys
- [ ] All network requests use HTTPS
- [ ] Input validation on all user inputs
- [ ] Biometric/PIN authentication working
- [ ] Screenshot blocking functional
- [ ] Clipboard auto-clear functional
- [ ] No sensitive data in console logs
- [ ] Deep link parameters validated
- [ ] Rate limiting on authentication attempts

### Code Review Checklist

- [ ] No `console.log` with sensitive data (mnemonic, private key, PIN)
- [ ] All crypto operations use secure random generation
- [ ] Key derivation uses sufficient iterations (>=100,000)
- [ ] Comparisons of sensitive data use constant-time
- [ ] Error messages do not expose sensitive information
- [ ] Async operations handle errors properly

---

## Reporting Security Issues

### Responsible Disclosure

If you discover a security vulnerability, please report it responsibly:

1. **Email**: security@protocol01.dev
2. **Subject**: [SECURITY] Brief description
3. **Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 24 hours
- **Initial Assessment**: Within 72 hours
- **Fix Timeline**: Based on severity
  - Critical: 24-48 hours
  - High: 1 week
  - Medium: 2 weeks
  - Low: Next release

### Bug Bounty

Contact security@protocol01.dev for information about our bug bounty program.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-19 | Initial security documentation |

---

## Additional Resources

- [OWASP Mobile Security Testing Guide](https://owasp.org/www-project-mobile-security-testing-guide/)
- [React Native Security Best Practices](https://reactnative.dev/docs/security)
- [Expo Security Documentation](https://docs.expo.dev/guides/security/)
- [Solana Security Best Practices](https://docs.solana.com/developing/security)
