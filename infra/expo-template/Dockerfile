# Appable golden Expo template image (v2 — Expo Router).
# Build as appable/expo-template:v2-native — never overwrite :v1.

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

ENV EXPO_NO_TELEMETRY=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /template
RUN npx --yes create-expo-app@latest . --template blank-typescript@sdk-54 --no-install -y \
    && npm install \
    && npx expo install react-dom react-native-web @expo/metro-runtime \
        @react-native-async-storage/async-storage @expo/vector-icons expo-font \
        expo-haptics expo-blur expo-symbols expo-status-bar \
        @react-native-community/datetimepicker \
        expo-router react-native-screens react-native-safe-area-context \
        expo-linking expo-constants

COPY template-files/ .

# v2: Expo Router entry, no legacy App.tsx
RUN rm -f App.tsx index.ts \
    && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.main='expo-router/entry';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"

RUN git config --global user.email "agent@appable.dev" \
    && git config --global user.name "Appable Agent" \
    && git config --global init.defaultBranch main \
    && git config --global --add safe.directory /app

COPY start.sh /usr/local/bin/appable-start
RUN sed -i 's/\r$//' /usr/local/bin/appable-start \
    && chmod +x /usr/local/bin/appable-start

WORKDIR /app
EXPOSE 8081
CMD ["appable-start"]
