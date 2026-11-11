# Build from the repository root: docker build -f apps/relay/Dockerfile -t pairwise-relay .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/core packages/core
COPY apps/relay apps/relay
RUN npm install --workspace @pairwise/relay --include-workspace-root=false \
 && npm run build -w @pairwise/core && npm run build -w @pairwise/relay

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/apps/relay/dist apps/relay/dist
COPY --from=build /app/apps/relay/package.json apps/relay/package.json
USER node
EXPOSE 9443
ENTRYPOINT ["node", "apps/relay/dist/main.js"]
