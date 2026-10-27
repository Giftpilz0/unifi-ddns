set shell := ["bash", "-euo", "pipefail", "-c"]

# List recipes
default:
    @just --list --unsorted

# Run all linters and formatters (pre-commit); CI runs this too
lint *args:
    bun install --frozen-lockfile
    pre-commit run --all-files {{args}}

# Definition of done: lint, type check and tests
check: lint test

# Type check and run the tests
test:
    bun install --frozen-lockfile
    bun run typecheck
    bun test

# Local worker on :8787 (wrangler dev)
dev:
    bun run dev

# Deploy by hand; normally Cloudflare Workers Builds deploys on push to main
deploy:
    bun run deploy
