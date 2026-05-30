FROM python:3.12-slim

# No third-party dependencies — stdlib only.
WORKDIR /app
COPY vigil_agent.py /app/vigil_agent.py
COPY config.json /app/config.json

# Drop privileges.
RUN useradd -r -u 10001 vigil
USER vigil

EXPOSE 8787
ENTRYPOINT ["python3", "/app/vigil_agent.py", "--config", "/app/config.json"]
