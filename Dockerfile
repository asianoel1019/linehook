FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# 技能庫：library/ 在版控之外，改在 build stage 由腳本從 dist 產生（zip 內含 index.js，
# 裝進 data/skills 即可直接執行，不需 TS 執行環境）。
COPY scripts/build-library.mjs ./scripts/build-library.mjs
RUN node scripts/build-library.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/library ./library
# 技能用 @lw/* 別名匯入宿主模組；這個 hook 必須隨主程式一起載入。
COPY alias.mjs alias-hooks.mjs ./
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
CMD ["node", "--import", "./alias.mjs", "dist/index.js"]
