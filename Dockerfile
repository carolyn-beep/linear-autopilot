# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist

# Install Claude Code CLI
# Note: This requires the Claude Code CLI to be available
# In production, you may need to install it separately or mount it as a volume
RUN npm install -g @anthropic-ai/claude-code || echo "Claude CLI not available in build"

# Install git for branch operations
RUN apk add --no-cache git

# Install GitHub CLI for PR creation
RUN apk add --no-cache github-cli

# Create data directory for memory/costs
RUN mkdir -p /app/data

# Create a non-root user and give it ownership of the app directory.
# All tooling above (npm, git, gh, claude CLI) is installed as root; we only
# drop privileges for the running process.
RUN addgroup -S autopilot && adduser -S autopilot -G autopilot \
  && chown -R autopilot:autopilot /app
USER autopilot

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Run the server
CMD ["node", "dist/server/index.js"]
