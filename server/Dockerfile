FROM python:3.12-slim
WORKDIR /app/server
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPOL_UPLOAD_DIR=/app/uploads
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt
COPY server/app.py /app/server/app.py
COPY client/ui /app/client/ui
RUN mkdir -p /app/uploads
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
