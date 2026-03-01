# Model Router Dockerfile
# Multi-stage build: compile TypeScript in the build stage, run minimal image in production.

# ─── Stage 1: Build ─────────────────────────────────────────────────────────

FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies (including devDeps for TypeScript compile)
COPY package*.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ─── Stage 2: Production ────────────────────────────────────────────────────

FROM node:22-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Runtime configuration
ENV NODE_ENV=production
ENV PORT=3003
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info
ENV DEFAULT_TIER=standard
ENV DEFAULT_OUTPUT_RATIO=0.33

# Data directory for SQLite (mount a volume in production)
RUN mkdir -p /data
ENV DB_PATH=/data/modelrouter.db

EXPOSE 3003

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3003/health || exit 1

CMD ["node", "dist/index.js"]
