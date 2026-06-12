# Rollback to v1 (launch-safe fallback)

Use this when v2 / native-iOS experiments fail and you need the **known-good** platform back.

**Frozen v1 code:** git tag `v1-launch-fallback` → commit `e4f7337`  
(Layer 1 iOS feel, tap-to-edit v13, screen background → `tokens.ts`, App.tsx tabs.)

---

## What rollback covers

| Layer | Rollback? | How |
|-------|-----------|-----|
| Appable repo (API, web, agent) | Yes | `git checkout v1-launch-fallback` |
| Golden Docker image | Yes | `GOLDEN_IMAGE=appable/expo-template:v1` in `.env` |
| New project containers | Yes | Only new starts use the image you set |
| Existing project volumes | Partial | Files stay on disk; restart container on v1 image |
| GitHub remote | Yes | Tag is pushed; clone/checkout anytime |

**Not automatic:** apps already generated on a v2 template keep their v2 source until rebuilt or manually fixed.

---

## Quick rollback (code + new containers)

```powershell
# 1. Code
cd C:\Users\yoven\.cursor\projects\empty-window\appable-real-real
git fetch --tags
git checkout v1-launch-fallback

# 2. Golden image (must exist — see snapshot below)
# In .env:
#   GOLDEN_IMAGE=appable/expo-template:v1

# 3. Rebuild v1 golden if missing
docker build -t appable/expo-template:v1 -f infra/expo-template/Dockerfile infra/expo-template
docker tag appable/expo-template:v1 appable/expo-template:latest   # optional: make latest = v1 again

# 4. Restart API
pnpm --filter @appable/api dev

# 5. Recreate a test project container (stop old, start fresh build or POST /projects/:id/start)
```

---

## Before any v2 work — snapshot v1 golden (do once)

While still on v1 code:

```powershell
docker build -t appable/expo-template:v1 -f infra/expo-template/Dockerfile infra/expo-template
docker tag appable/expo-template:v1 appable/expo-template:v1-launch
```

**Never overwrite `v1` or `v1-launch` when building v2.** Publish v2 as:

```powershell
docker build -t appable/expo-template:v2-native -f infra/expo-template/Dockerfile infra/expo-template
```

Test v2 only with:

```env
GOLDEN_IMAGE=appable/expo-template:v2-native
```

---

## Branch strategy (recommended)

| Branch / tag | Purpose |
|--------------|---------|
| `main` | Production line — merge only when stable |
| `v1-launch-fallback` (tag) | Immutable snapshot; never move |
| `golden-v2` (branch) | Expo Router + native tabs + tap-to-edit v2 |

Work v2 on `golden-v2`. Merge to `main` when acceptance tests pass. If not, stay on tag + v1 image.

---

## v2 experiment without losing v1

1. Tag exists: `v1-launch-fallback`
2. Docker: `v1` image tagged locally (and ideally pushed to your registry)
3. `.env` switches `GOLDEN_IMAGE` — no code change needed to flip containers
4. Tap-to-edit v2 spec: `tap-to-edit-v2.md` — v2 must pass before replacing `latest`

---

## Push tag to GitHub (one time)

```powershell
git push origin v1-launch-fallback
```

Then any machine can `git checkout v1-launch-fallback`.
