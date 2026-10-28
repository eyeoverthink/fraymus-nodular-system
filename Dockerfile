FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY supabase ./supabase
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server/index.js"]
