# Contributing to @p01/privacy-toolkit

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Issues

- Search existing issues before opening a new one.
- Use a clear, descriptive title.
- Include steps to reproduce for bugs, or a clear use case for feature requests.
- Tag issues appropriately (bug, enhancement, question).

## Pull Requests

1. Fork the repository and create a branch from `main`.
2. Install dependencies: `npm install`
3. Make your changes in the `src/` directory.
4. Add or update tests in `test/` for any new functionality.
5. Run `npm test` and ensure all tests pass.
6. Run `npm run build` and ensure TypeScript compiles cleanly.
7. Write a clear PR description explaining what changed and why.

## Code Style

- TypeScript strict mode is enabled. Do not use `any` unless absolutely necessary.
- Use `bigint` for all field arithmetic (not `number` or `BN`).
- Document all exported functions with JSDoc comments.
- Keep functions pure where possible -- no side effects.
- Prefer descriptive names over abbreviations (e.g., `nullifierPreimage` not `np`).
- One module per concern: merkle, commitment, proof, utils.
