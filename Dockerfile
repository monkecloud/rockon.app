# Multi-stage: build the Vite frontend with full devDependencies, then ship
# only production deps + the built dist/ + the server. Node 24 matches
# package.json's "engines" field; alpine is fine here since nothing in this
# app (pg, @aws-sdk/client-s3, bcryptjs) needs native compilation.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Matches k8s/site.yaml's containerPort — the cluster's app-repo template
# always targets 8080 rather than each app's own default port.
ENV PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
EXPOSE 8080
USER node
CMD ["node", "server/worker.js"]
