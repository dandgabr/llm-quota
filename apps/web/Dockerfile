# syntax=docker/dockerfile:1
# llm-quota web — engine-agnostic (Docker OR Podman).
# Build stage: Vite build of the Vue 3 SPA.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json turbo.json ./
COPY packages/ packages/
COPY apps/api/package.json apps/api/package.json
COPY apps/web/ apps/web/
RUN pnpm install --frozen-lockfile
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
# Full workspace build first: the SPA imports @llm-quota/shared etc. whose
# entrypoints are dist/ outputs.
RUN pnpm -r build

# Runtime: nginx serves the static SPA + proxies /v1 to the api service.
FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
