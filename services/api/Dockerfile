FROM python:3.10-slim

WORKDIR /app

COPY services/api/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY DB.py /app/DB.py
COPY services/api/app.py /app/app.py
COPY services/api/static /app/static

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
