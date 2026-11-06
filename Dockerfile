FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data && chown node:node /data
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e 'fetch("http://127.0.0.1:4173/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "bin/safe-tx-lens.mjs", "serve", "--community"]
