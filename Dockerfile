FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN npm install --global npm@11.6.2
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends graphicsmagick ghostscript poppler-utils \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.6.2
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/services ./services
COPY --from=build /app/shared ./shared
COPY --from=build /app/ecosystem.config.cjs ./ecosystem.config.cjs
RUN mkdir -p /app/data

EXPOSE 6722
CMD ["npm", "run", "start"]
