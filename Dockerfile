# The API server runs as its own container (Cloud Run) so the keys live only here.
# Build the web app separately and serve dist/ from any static host.
FROM node:22-alpine
WORKDIR /app
COPY server ./server
ENV NODE_ENV=production
ENV API_PORT=8080
EXPOSE 8080
# Keys arrive as container secrets, never as build args or files in the image.
CMD ["node", "server/dev.mjs"]
