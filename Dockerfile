FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the project
RUN npm run build

# Production image, copy all the files and run
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 expressjs

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Copy swagger.json
COPY --from=builder /app/swagger.json ./swagger.json

# Copy assets and default-assets fallback
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/assets ./default-assets

USER expressjs

# Note: EXPOSE is informational, but we want it to be variable. 
# Docker doesn't support ENV vars in EXPOSE directly in a useful way for documentation without ARG, 
# but it doesn't affect functionality if specific port is mapped in compose.

ENV HOSTNAME "0.0.0.0"

CMD ["node", "dist/index.js"]
