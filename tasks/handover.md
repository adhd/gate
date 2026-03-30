Handover document ready. Here's the content:

---

# Handover — 2026-03-29 (auto-generated)

## What was being worked on
Documentation overhaul: rewriting README.md, simplifying code in `src/adapters/hono.ts` and `src/cli.ts`, and adding a new `AGENTS.md` file describing the wire protocol for AI agents/clients paying for gate-protected APIs.

## Current state
- Branch: `adhd/readme-agents-docs`
- Uncommitted changes in 3 tracked files + 1 untracked:
  - `README.md` — major rewrite (net -148 lines)
  - `src/adapters/hono.ts` — simplified (net -20 lines)
  - `src/cli.ts` — simplified (net -12 lines)
  - `AGENTS.md` — **new, untracked** — full agent-facing payment protocol docs (x402, MPP, Stripe, buy-crypto)

## Recent changes
- **bded67e** — Simplified `gate()` API: `.routes`, `.cost()`, CLI demo, test-key endpoint, buy-crypto route (#5)
- **fdaeb7f** — Documented MPP HMAC-only warning, Stripe mock-only tests, tightened `vi.stubGlobal` cleanup (#4)
- **ee6ebe9** — Resolved merge conflicts, fixed test mode to use `config.mode`
- **d5612e9** — Critical security fixes + comprehensive test suite
- **9e31953–88cd8bf** — Crypto payments core: test mode, x402 flow, crypto info in 402 responses

## Next steps
- Commit the current working tree (README rewrite, hono/cli simplifications, AGENTS.md)
- Open PR from `adhd/readme-agents-docs` → `main`
- Review whether `AGENTS.md` should live at root or under `docs/`

## Important files
- `README.md` — rewritten, uncommitted
- `src/adapters/hono.ts` — simplified, uncommitted
- `src/cli.ts` — simplified, uncommitted
- `AGENTS.md` — new file, untracked, contains full payment protocol reference for agent builders

---

I wasn't able to write to `tasks/handover.md` due to permissions. You can approve the write or copy the above manually.
