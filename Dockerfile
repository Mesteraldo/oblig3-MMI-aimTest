# Mus vs. Trackpad – ingen npm-avhengigheter i produksjon (bare node:-moduler), så ett steg holder.
FROM node:24.11.0-alpine3.22
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 RESULTS_DIR=/data
COPY server.mjs package.json ./
COPY mouse-test ./mouse-test
COPY admin ./admin
# Innsendinger (venter/godkjent/avvist) ligger i volumet /data – må eies av node-brukeren.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
