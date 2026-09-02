FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY shared/package.json shared/package.json
COPY ai/package.json ai/package.json
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY shared shared
COPY ai ai
COPY backend backend
CMD ["npm", "run", "start", "-w", "backend"]