# syntax=docker/dockerfile:1

# --- build: all dependencies + compilation (also used by the migrate and demo receiver services) ---
FROM node:24-slim AS build
WORKDIR /app
# The Prisma CLI migration engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall -> prisma generate (the schema was copied above)
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: production dependencies and compiled code only ---
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
