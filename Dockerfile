# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN corepack enable && \
    corepack prepare pnpm@latest --activate && \
    pnpm install --frozen-lockfile

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Install pnpm
RUN corepack enable && \
    corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only and build better-sqlite3
RUN pnpm install --prod --frozen-lockfile

# Copy application code
COPY index.js ./

# Create directory for database
RUN mkdir -p /data

# Set environment variables
ENV NODE_ENV=production
ENV DB_PATH=/data/clips.db
ENV PORT=3000
ENV CRON_SCHEDULE="0 */6 * * *"

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/clip', (r) => {process.exit(r.statusCode === 200 || r.statusCode === 404 ? 0 : 1)})"

# Run the application
CMD ["node", "index.js"]
