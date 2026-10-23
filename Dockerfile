# ---- build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
RUN SKIP_CLIENT_INSTALL=1 npm ci && npm --prefix client ci
COPY . .
RUN npm run build

# ---- runtime stage
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN SKIP_CLIENT_INSTALL=1 npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8080
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
