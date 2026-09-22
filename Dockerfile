FROM node:24-alpine
# Patch OS packages (alpine's openssl/libcrypto3 CVEs) and upgrade npm so its
# bundled dependencies (tar, minimatch, brace-expansion, pacote, sigstore ...)
# are the fixed versions — otherwise the Trivy image scan fails on HIGH/CRITICAL
# findings that live in the base image, not in our dependency tree.
# (npm 12 requires node >=24.15, hence the node:24 base.)
RUN apk upgrade --no-cache && npm install -g npm@latest
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: the backend tree has no native modules requiring build
# scripts, and skipping lifecycle scripts hardens the image against
# supply-chain postinstall attacks (husky prepare is a no-op without .git).
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
# Autonomous trading server: HTTP control plane + WS telemetry + background engines
EXPOSE 3003
CMD ["npm", "start"]
