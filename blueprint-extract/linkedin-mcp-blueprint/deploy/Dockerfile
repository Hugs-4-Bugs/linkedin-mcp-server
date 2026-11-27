# LinkedIn MCP server — production-style image (multi-stage, non-root).
# TLS termination is expected at the proxy (see deploy/docker-compose.yml);
# this process binds 0.0.0.0:3333 behind that proxy in staging/production.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# app user (alpine): no root at runtime
RUN addgroup -S app && adduser -S app -G app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY .env.example ./deploy/.env.example.reference
USER app
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3333)+'/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/mcp/transport/http-entry.js"]
