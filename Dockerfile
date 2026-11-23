# One image for all Node services (api, ingest, simulator); compose picks the command.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/ingest/package.json apps/ingest/
COPY apps/simulator/package.json apps/simulator/
RUN npm ci --omit=dev && npm cache clean --force

COPY packages packages
COPY apps apps
COPY db db

USER node
EXPOSE 3000
CMD ["node", "apps/api/src/server.js"]
