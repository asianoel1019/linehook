FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY README.md ./
COPY icons ./icons
COPY public ./public
# J2：以非 root（node 內建 uid 1000）執行。資料目錄與設定檔都要可寫，
# 否則 LINE 登入（storage.json）、settings.json、log、sqlite 都會失敗。
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8090
# J2 / C1：liveness 打 /healthz（不呼叫任何平台）——平台掛掉時不該被重啟。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
