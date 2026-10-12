FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY server.js token.js ./
ENV FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 8090
CMD ["node", "server.js"]
