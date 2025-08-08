# OR-Tools配送ルート最適化システム

Google Apps ScriptとOR-Toolsを使用した配送ルート最適化システムです。

## 概要

このシステムは以下の機能を提供します：

- 複数社員の配送ルート最適化
- 2人対応・1人対応の区別
- スプレッドシートとの連携
- Google Mapsでのルート可視化
- Docker上のPythonサーバーとの連携

## ファイル構成

- `code.js` - メインのGoogle Apps Scriptコード
- `map.html` - Google Mapsルート表示用HTML
- `main.py` - OR-Toolsを使用したPythonサーバー
- `Dockerfile` - Dockerコンテナ設定
- `requirements.txt` - Python依存関係

## 開発環境

### 必要なツール

- Google Apps Script CLI (clasp)
- Git
- Docker (オプション)

### セットアップ

1. claspでGASプロジェクトをクローン
2. 必要に応じてAPIキーを設定
3. Dockerでローカル開発環境を起動

## 更新履歴

このリポジトリで変更履歴を管理しています。
