# @keyholder as a container. Build from the keyholder folder:
#
#   docker build -t dualdrive-keyholder keyholder
#   docker run -d --restart unless-stopped --env-file /path/to/keyholder.env \
#     -v dualdrive-state:/data dualdrive-keyholder
#
# The build stage bundles src/ with esbuild (installed alongside tsx); the
# runtime stage has Node, @octokit/rest and the bundle, nothing else.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx --no-install esbuild src/main.ts src/register.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --packages=external --out-extension:.js=.mjs --outdir=dist

FROM node:22-alpine
ENV NODE_ENV=production \
    KEYHOLDER_STATE_FILE=/data/state.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && mkdir /data && chown node:node /data
COPY --from=build /src/dist ./dist
USER node
# Approvals counted so far and the stream's connection id. Without a volume
# a restarted container forgets both.
VOLUME ["/data"]
CMD ["node", "dist/main.mjs"]
