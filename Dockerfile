FROM python:3.10-slim

WORKDIR /app

# まず requirements.txt をコピー
COPY requirements.txt /app/

# pip を最新化してから ライブラリをインストール
RUN pip install --no-cache-dir -U pip \
 && pip install --no-cache-dir -r requirements.txt

# アプリ本体をコピー (app.py など)
COPY . /app/

EXPOSE 9999

CMD ["gunicorn", "--bind", "0.0.0.0:9999", "main:app"]
