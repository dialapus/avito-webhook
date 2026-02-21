FROM node:22-alpine
WORKDIR /app
COPY package.json .
COPY server.js .
RUN mkdir -p cache/chats
EXPOSE 4040
CMD ["node", "server.js"]
