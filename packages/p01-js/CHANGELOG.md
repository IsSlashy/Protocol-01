# Changelog

All notable changes to the `p-01` SDK will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-01-31

### Added

- **Core SDK** (`Protocol01` class) with wallet connection, one-time payments, and subscription management.
- **Stream Secure subscriptions** with configurable intervals (weekly, monthly, quarterly, yearly) and privacy options.
- **React components**: `P01Provider`, `WalletButton`, `PaymentButton`, `SubscriptionButton`, `SubscriptionWidget`, and `SubscriptionCard`.
- **Service Registry** with 60+ known services across streaming, music, AI, gaming, SaaS, news, fitness, VPN, cloud, and education categories.
- **Security module** with stealth addresses (DKSAP), end-to-end encryption, and confidential transactions built on `@noble/curves`, `@noble/hashes`, and `@noble/ciphers`.
- **Utility functions** for token resolution, amount formatting, interval handling, and merchant config validation.
- **Privacy-first design**: optional amount noise, timing noise, and stealth address generation for subscriber privacy.
- Dual CJS/ESM build output with full TypeScript declarations.
- Storybook integration for visual component development.

[0.1.0]: https://github.com/IsSlashy/protocol-01/releases/tag/p-01-v0.1.0
