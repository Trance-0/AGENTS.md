FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY public/ ./public/

ENV NODE_ENV=production
EXPOSE 14141

CMD ["node", "server/index.js"]
