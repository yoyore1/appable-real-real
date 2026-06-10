# Appable

AI mobile-app builder for people who can't code. Phase-1 backend engine:
idea → AI interview → app spec → agent builds a real Expo app in a Docker
container → live phone preview + Expo Go QR code.

## Architecture

| Piece | What it is |
|---|---|
| `apps/api` | Fastify backend: auth, projects, WS gateway, orchestrator, agent loop, interview pipeline |
| `apps/proxy` | Preview proxy: routes `/p/:projectId/*` to project containers (Redis registry) |
| `apps/web` | Minimal dev console: chat, build stream, phone-framed preview, QR |
| `packages/shared` | WS protocol + AppSpec types |
| `packages/db` | Prisma schema (Postgres) |
| `infra/` | docker-compose (Postgres + Redis) and the golden Expo template image |

Models run on DeepInfra (OpenAI-compatible): Qwen for interview/brainstorm,
Kimi K2.6 for builds, with explicit escalation rules.

## Setup

Prereqs: Node 22+, pnpm 10+, Docker Desktop running.

```bash
pnpm install
cp .env.example .env           # then fill in DEEPINFRA_API_KEY

# infra
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate

# golden Expo image (one-time, ~5 min)
docker build -t appable/expo-template:latest infra/expo-template

# run everything
pnpm dev
```

Open http://localhost:5173, register, create an app, do the interview,
press Build.

To test on a real phone, set `PUBLIC_HOST` in `.env` to your machine's LAN
IP and make sure the phone is on the same Wi-Fi, then scan the QR with
Expo Go.

## Notes

- Project files live in per-project Docker volumes; the agent edits them via
  `docker exec`, so Metro hot reload works on every host OS.
- Every successful build creates a git checkpoint inside the project volume
  (powers undo/rollback).
- Idle containers are put to sleep automatically (`IDLE_TIMEOUT_MINUTES`).
