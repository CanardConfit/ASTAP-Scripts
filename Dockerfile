FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN yarn build


FROM node:22-bookworm-slim AS production-dependencies

ENV NODE_ENV=production
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true \
    && yarn cache clean


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    ASTAP_DOWNLOAD_DIR=/downloads
WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir --parents /downloads \
    && chown node:node /downloads

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

USER node

VOLUME ["/downloads"]

ENTRYPOINT ["tini", "--", "node", "--no-warnings", "dist/index.js"]
