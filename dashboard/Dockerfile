FROM node:22-alpine

WORKDIR /app

LABEL org.opencontainers.image.version="0.2.0"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY public/ ./public/
RUN mkdir /app/data && chown node:node /app/data
USER node

ENV NODE_ENV=production
EXPOSE 14141

CMD ["node", "server/index.js"]
