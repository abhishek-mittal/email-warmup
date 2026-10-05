FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js ./
ENV PORT=2525
EXPOSE 2525
USER node
CMD ["node", "index.js"]
