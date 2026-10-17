FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip && \
    pip3 install --break-system-packages -U "yt-dlp[default,curl-cffi]" && \
    echo "--no-warnings" > /etc/yt-dlp.conf && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .
CMD ["node", "server.js"]
