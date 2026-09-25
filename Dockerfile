# Hireriv – production image. Node 22.13+ is needed for the built-in SQLite.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3004 \
    DB_FILE=/var/lib/hireriv/hireriv.db \
    UPLOADS_DIR=/var/lib/hireriv/uploads

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# Database and resumes live on one persistent volume, separate from the code.
RUN mkdir -p /var/lib/hireriv/uploads && chown -R node:node /var/lib/hireriv /app/data
VOLUME ["/var/lib/hireriv"]
USER node

EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server.js"]
