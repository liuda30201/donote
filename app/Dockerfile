FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY server.js ./
COPY src ./src
COPY public ./public

EXPOSE 3000

ENV PORT=3000
ENV EXPIRE_HOURS=168

# Single-user mode (default).
# ENV ACCESS_PASSWORD=yourpassword

# Multi-user mode.
# ENV ACCESS_PASSWORDS=user1:pass1,user2:pass2,user3:pass3
# ENV MIGRATE_DEFAULT_USER=user1

CMD ["node", "server.js"]
