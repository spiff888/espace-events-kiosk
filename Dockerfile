FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV CONFIG_PATH=/config/config.json DATA_DIR=/data TZ=America/Los_Angeles
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=5m --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "server.js"]
