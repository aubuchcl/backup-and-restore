FROM node:22-bookworm-slim

ARG MONGO_TOOLS_REPO=7.0
RUN apt-get update \
     && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
     && curl -fsSL https://pgp.mongodb.com/server-${MONGO_TOOLS_REPO}.asc \
     | gpg --dearmor -o /usr/share/keyrings/mongodb.gpg \
     && echo "deb [signed-by=/usr/share/keyrings/mongodb.gpg] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/${MONGO_TOOLS_REPO} main" \
     > /etc/apt/sources.list.d/mongodb.list \
     && apt-get update \
     && apt-get install -y --no-install-recommends mongodb-database-tools \
     && apt-get purge -y gnupg \
     && apt-get autoremove -y \
     && rm -rf /var/lib/apt/lists/*

# Amazon's CA bundle, for TLS to DocumentDB.
RUN curl -fsSL -o /app/global-bundle.pem --create-dirs \
     https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

RUN mkdir -p /data/backups
VOLUME ["/data/backups"]

ENV NODE_ENV=production
ENV PORT=4000
ENV BACKUP_DIR=/data/backups
EXPOSE 4000


CMD ["node", "src/server.js"]
