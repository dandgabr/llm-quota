# syntax=docker/dockerfile:1
# llm-quota API — engine-agnostic (Docker OR Podman).
# Build stage: install + compile the TypeScript monorepo's api package.
FROM node:22-alpine AS build
WORKDIR /app
# Corepack for pnpm@12.3.4
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/ packages/
RUN pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile
# Full workspace build: the api imports @llm-quota/* whose runtime entrypoints
# are their dist/ outputs — building only the api package breaks the image.
RUN pnpm -r build

# Runtime stage: minimal, non-root.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S llmquota && adduser -S llmquota -G llmquota
COPY --from=build --chown=llmquota:llmquota /app/apps/api/dist ./dist
COPY --from=build --chown=llmquota:llmquota /app/node_modules ./node_modules
COPY --from=build --chown=llmquota:llmquota /app/packages ./packages
COPY --from=build --chown=llmquota:llmquota /app/package.json ./package.json
USER llmquota
EXPOSE 3000
CMD ["node", "dist/bin.js"]
