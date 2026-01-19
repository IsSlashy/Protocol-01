# Contributing to Protocol 01

Thank you for your interest in contributing to Protocol 01! This document provides guidelines for contributing to the project.

## Code of Conduct

Please be respectful and constructive in all interactions. We welcome contributors of all backgrounds and experience levels.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies with `pnpm install`
4. Create a feature branch

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/protocol-01.git
cd protocol-01

# Install dependencies
pnpm install

# Start development servers
pnpm dev
```

## Project Structure

```
protocol-01/
├── apps/
│   ├── extension/     # Browser extension
│   ├── mobile/        # React Native app
│   └── web/           # Next.js website
├── packages/
│   └── sdk/           # JavaScript SDK
└── docs/              # Documentation
```

## Making Changes

### Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation
- `refactor/` - Code refactoring

Example: `feature/hardware-wallet-support`

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add hardware wallet support
fix: resolve balance display issue
docs: update SDK documentation
refactor: improve encryption performance
```

### Code Style

- Use TypeScript for all new code
- Follow existing code patterns
- Run linting before committing
- Add tests for new features

```bash
# Lint code
pnpm lint

# Run tests
pnpm test
```

## Pull Requests

1. Update your fork with the latest changes
2. Create a pull request with a clear description
3. Link any related issues
4. Wait for review

### PR Checklist

- [ ] Code follows project style
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No breaking changes (or documented)

## Reporting Issues

### Bug Reports

Include:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details
- Screenshots if applicable

### Feature Requests

Include:
- Clear description of the feature
- Use cases
- Potential implementation approach

## Security

If you discover a security vulnerability, please email security@protocol01.xyz instead of opening a public issue.

## Questions?

- Open a GitHub Discussion
- Join our Discord
- Tweet @protocol01

Thank you for contributing!
