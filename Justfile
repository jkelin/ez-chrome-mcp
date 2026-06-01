start:
    bun run index.ts

dev:
    bun run dev

typecheck:
    bun run typecheck

test:
    bun run test

test-unit:
    bun run test:unit

test-integration:
    bun run test:integration

check: typecheck test
