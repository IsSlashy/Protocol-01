#!/bin/bash
# Vercel install script for apps/mugen.
# Runs from the Vercel Root Directory (apps/mugen) — cd to repo root first.
# `set -ex` gives us per-command tracing so Vercel's log streams every step.

set -ex

echo "--- pwd before cd ---"
pwd
ls -la

cd ../..

echo "--- pwd at repo root ---"
pwd
ls -la

pnpm install --frozen-lockfile

echo "--- packages/ listing ---"
ls -la packages/ || echo "NO packages/ DIR"

cd packages/privacy-toolkit
pnpm exec tsc
cd ../..

cd packages/arcium-sdk
pnpm exec tsup
cd ../..

cd packages/privacy-sdk
pnpm exec tsup
cd ../..

echo "workspace SDKs built successfully"
