# Contributing

Thank you for considering contributing to ZK Mobile Pipeline!

## How to Contribute

1. **Fork** the repository and create a feature branch.
2. **Make your changes** — ensure all scripts remain generic and reusable.
3. **Test** your changes with at least one circom circuit end-to-end.
4. **Submit a pull request** with a clear description of what you changed and why.

## Guidelines

- All scripts must be generic (no project-specific references).
- Gotchas must include the actual time lost discovering the issue.
- Examples should be minimal and self-contained.
- Documentation should be clear enough for someone new to ZK on Solana.

## Adding a Gotcha

If you discovered a painful ZK/Solana integration issue, please add it:

1. Create a new file in `gotchas/` with a descriptive name.
2. Follow the existing format: Problem, Symptom, Fix, Notes.
3. Include the estimated time lost discovering it.
4. Reference the relevant library or tool (snarkjs, ark-circom, Solana, etc.).

## Code of Conduct

Be respectful and constructive. We are all here to make ZK development less painful.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
