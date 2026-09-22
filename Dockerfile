FROM node:20-alpine
# Patch OS packages (alpine's openssl/libcrypto3 CVEs) and upgrade npm so its
# bundled dependencies (tar, minimatch, brace-expansion, pacote, sigstore ...)
# are the fixed versions — otherwise the Trivy image scan fails on HIGH/CRITICAL
# findings that live in the base image, not in our dependency tree.
RUN apk upgrade --no-cache && npm install -g npm@latest
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Autonomous trading server: HTTP control plane + WS telemetry + background engines
EXPOSE 3003
CMD ["npm", "start"]
