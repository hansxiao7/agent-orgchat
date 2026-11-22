# Build from the repository root: docker build -f bridge/Dockerfile -t orgchat-bridge .
FROM node:22-alpine
WORKDIR /app/bridge
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci --omit=dev
COPY client/lib /app/client/lib
COPY bridge/index.mjs ./
COPY bridge/src ./src
RUN mkdir -p /data && chown node /data
USER node
ENV ORGCHAT_BRIDGE_STATE=/data
VOLUME /data
CMD ["node", "index.mjs"]
