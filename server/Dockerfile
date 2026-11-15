# Build from repository root so the Python API and browser UI are both served.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPOL_UPLOAD_DIR=/app/server/uploads
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt
COPY server/app.py /app/server/app.py
COPY server/server_spaces.py /app/server/server_spaces.py
COPY client/ui /app/client/ui
RUN mkdir -p /app/server/uploads
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
