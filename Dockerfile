# Multi-stage production build for PulseBill Telecom Daemon
FROM node:20-alpine AS base

WORKDIR /app

# Install system utilities required for native builds (node-gyp, sqlite, etc.)
RUN apk add --no-cache python3 make g++ sqlite-dev

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Production Runner
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=base /app/node_modules ./node_modules
COPY . .

# Expose HTTP REST / Webhook ingress port
EXPOSE 3001

# Healthcheck endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "app.js"]
