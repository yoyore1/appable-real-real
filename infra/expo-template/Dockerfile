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

# Build the template app at image build time so versions always resolve
# to a coherent, current Expo SDK without hand-pinning.
WORKDIR /template
RUN npx --yes create-expo-app@latest . --template blank-typescript --no-install \
    && npm install \
    && npx expo install react-dom react-native-web @expo/metro-runtime @react-native-async-storage/async-storage

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
