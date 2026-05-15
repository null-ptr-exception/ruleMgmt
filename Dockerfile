FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl make \
    && curl -fsSL https://get.helm.sh/helm-v3.17.3-linux-$(dpkg --print-architecture).tar.gz \
       | tar xz -C /usr/local/bin --strip-components=1 linux-$(dpkg --print-architecture)/helm \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN make apply-sample
CMD ["node", "server.js"]
