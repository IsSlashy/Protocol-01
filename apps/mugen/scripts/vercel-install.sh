#!/bin/bash
# Vercel install script for apps/mugen.
# Runs from the Vercel Root Directory (apps/mugen) — cd to repo root first.
# `set -ex` gives us per-command tracing so Vercel's log streams every step.

set -ex

cd ../..

pnpm install --frozen-lockfile

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
