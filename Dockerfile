FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache git helm

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server.js ./
COPY server/ ./server/
COPY sample/ ./sample/
COPY index.html ./

EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
