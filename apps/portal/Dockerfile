# Portal service: Flask serves the React UI (/app/) and proxies /api/* to the FastAPI backend.
# Build context is the repository root (see deploy/docker-compose.yml).

# --- build the React UI ---
FROM node:22-alpine AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

# --- runtime ---
FROM python:3.11-slim

WORKDIR /app

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY apps/portal/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Flask app
COPY apps/portal/flask_app.py .

# React UI build output, served at /app/ (baked into the image, never bind-mounted)
COPY --from=web /web/dist ./web/

# Expose port 80
EXPOSE 80

# Run with gunicorn for production
# Using 4 workers for better concurrency
CMD ["gunicorn", "--bind", "0.0.0.0:80", "--workers", "4", "--timeout", "120", "flask_app:app"]
