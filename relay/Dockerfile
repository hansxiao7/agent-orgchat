FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.mjs ./
COPY src ./src
RUN mkdir -p /data && chown node /data
USER node
ENV PORT=8787 ORGCHAT_DB=/data/orgchat.db
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "index.mjs"]
