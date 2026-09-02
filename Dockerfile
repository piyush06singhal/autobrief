FROM node:20-slim

# Install the distro's Chromium plus fonts. We deliberately use the system
# Chromium rather than Puppeteer's bundled download: Google publishes no
# arm64-Linux build of Chrome-for-Testing, so the bundled binary silently
# breaks on arm64 hosts (AWS Graviton, Ampere, arm Macs). The distro package
# runs natively on both amd64 and arm64, and pulls in every shared lib it needs
# so we don't have to enumerate them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chromium and skip Puppeteer's bundled download at install time.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

# Default: run the scheduler (long-lived cron process).
# Override the command to run "node src/admin/server.js" or "node scripts/run-report.js" instead.
CMD ["node", "src/jobs/scheduler.js"]
