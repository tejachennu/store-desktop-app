# Central API image. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t store-api .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/desktop/package.json apps/desktop/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --workspace @store/server --workspace @store/shared --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build -w @store/server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
