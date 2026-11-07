FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node build/server ./server
COPY --chown=node:node build/demo ./demo
COPY --chown=node:node build/source.json ./source.json
RUN mkdir -p /app/recordings /home/node/Desktop/안경카메라_기록 \
    && chown -R node:node /app/recordings /home/node/Desktop
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/server.mjs"]
