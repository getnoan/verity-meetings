# verity-meetings — the booking service (renders its own pages)
FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "booking/server.mjs"]
