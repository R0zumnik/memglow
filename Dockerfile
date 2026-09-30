# memglow — live 3D view of a Markdown memory folder.
#   docker build -t memglow .
#   docker run -d -p 4747:4747 -v /path/to/notes:/memory:ro \
#     -e MEMGLOW_TOKEN=... -e MEMGLOW_PASSWORD=... memglow
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js THIRD_PARTY_LICENSES LICENSE ./
COPY lib ./lib
COPY public ./public
COPY hooks ./hooks
ENV NODE_ENV=production \
    MEMORY_DIR=/memory \
    HOST=0.0.0.0 \
    PORT=4747
# Read-only access to the notes is enough: memglow never writes to MEMORY_DIR.
USER node
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4747/api/graph >/dev/null || exit 1
CMD ["node", "server.js"]
