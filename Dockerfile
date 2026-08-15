FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci

COPY server server
COPY web web
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ARG CODEX_VERSION=0.147.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl git openssh-client ripgrep \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# 运行时只安装生产依赖，避免把 typescript/vitest/vite 等构建工具装进镜像
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/package.json ./web/package.json
RUN mkdir -p server web \
  && npm ci --omit=dev --workspace=@codex-ui/server \
  && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/data /home/user/.codex /home/user/code /home/user/server \
  && chown -R 1000:1000 /app /home/user

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    HOME=/home/user \
    CODEX_HOME=/home/user/.codex \
    DATA_DIR=/app/data \
    WEB_DIST=/app/web/dist

USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]
