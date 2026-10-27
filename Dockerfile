# The API server runs as its own container (Cloud Run) so the keys live only here.
# Build the web app separately and serve dist/ from any static host.
FROM node:22-alpine

# tini reaps zombies and forwards signals to the node process.
RUN apk add --no-cache tini

WORKDIR /app

# Dependencies first for layer caching. Only production deps: the API needs no
# build tooling, but it does need firebase-admin when AUTH_MODE=firebase.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Application code. Keys arrive as container secrets, never baked into the image.
COPY server ./server

ENV NODE_ENV=production \
    API_PORT=8080 \
    AUTH_MODE=firebase

# Run unprivileged. The node image already ships a `node` user (uid 1000); we use
# it rather than root and own nothing outside /app.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Health is the unauthenticated shape: {ok, mode}. Anything non-200 fails the probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||8080)+'/api/health').then(r=>r.json()).then(b=>process.exit(b&&typeof b.ok==='boolean'?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/server.mjs"]
