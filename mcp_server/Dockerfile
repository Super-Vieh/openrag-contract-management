FROM python:3.11-slim

# System-Abhängigkeiten aktualisieren (Security Best Practice)
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Einen sicheren, nicht-privilegierten Benutzer anlegen
RUN useradd -m -s /bin/bash mcpuser

WORKDIR /app

# Abhängigkeiten kopieren und installieren
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Den Code kopieren
COPY main.py .

# Rechte an den neuen Benutzer übergeben
RUN chown -R mcpuser:mcpuser /app

# Ab hier läuft der Container sicher als eingeschränkter Nutzer
USER mcpuser

# 0.0.0.0 ist Pflicht: mit 127.0.0.1 wäre der Server nur containerintern
# erreichbar und für Langflow (eigener Container) unansprechbar.
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["python", "main.py"]