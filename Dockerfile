FROM ghcr.io/puppeteer/puppeteer:latest

USER root

WORKDIR /app

COPY . .

RUN yarn

RUN yarn build