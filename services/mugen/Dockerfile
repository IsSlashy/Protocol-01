FROM node:22-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src/ ./src/
RUN npx tsup src/index.ts --format esm --outDir dist

EXPOSE 3002

CMD ["node", "dist/index.js"]
