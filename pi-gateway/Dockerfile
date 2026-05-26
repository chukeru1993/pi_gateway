FROM node:22-slim

RUN npm install -g @earendil-works/pi-coding-agent

WORKDIR /app
COPY dist/ ./dist/
COPY package.json .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/index.js"]
