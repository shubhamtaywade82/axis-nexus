FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# Autonomous trading server: HTTP control plane + WS telemetry + background engines
EXPOSE 3003
CMD ["npm", "start"]
