# Appable golden Expo template image.
# Contains a ready-to-run Expo (React Native) starter app with node_modules
# baked in, so project containers cold-start in seconds, not minutes.

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

ENV EXPO_NO_TELEMETRY=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Pin SDK 54 — matches Expo Go on the App Store / Play Store.
# create-expo-app@latest currently scaffolds SDK 56, which store Expo Go cannot open.
WORKDIR /template
RUN npx --yes create-expo-app@latest . --template blank-typescript@sdk-54 --no-install -y \
    && npm install \
    && npx expo install react-dom react-native-web @expo/metro-runtime \
        @react-native-async-storage/async-storage @expo/vector-icons expo-font \
        @expo-google-fonts/dm-sans @expo-google-fonts/fraunces

# Appable scaffold: design tokens + auth helpers (non-negotiables)
COPY template-files/ .

# Git identity for checkpoint commits made inside containers
RUN git config --global user.email "agent@appable.dev" \
    && git config --global user.name "Appable Agent" \
    && git config --global init.defaultBranch main \
    && git config --global --add safe.directory /app

COPY start.sh /usr/local/bin/appable-start
# Normalize line endings in case the build context comes from Windows
RUN sed -i 's/\r$//' /usr/local/bin/appable-start \
    && chmod +x /usr/local/bin/appable-start

WORKDIR /app
EXPOSE 8081
CMD ["appable-start"]
