FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.0.0 --activate
COPY package.json pnpm-lock.yaml .npmrc tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.0.0 --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 8082
CMD ["node", "dist/server.js"]
