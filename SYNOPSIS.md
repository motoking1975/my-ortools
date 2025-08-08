# OR-Tools配送ルート最適化システム - 概要

## システム構成

### フロントエンド
- **Google Apps Script**: ユーザーインターフェース
- **HTML/JavaScript**: ルート表示用マップ
- **スプレッドシート連携**: データ管理

### バックエンド
- **Python Flask**: APIサーバー
- **OR-Tools**: 配送ルート最適化エンジン
- **Docker**: コンテナ化

## 現在の設定状況

### コンテナ設定
- **コンテナ名**: `ortools-vrp-server`
- **ポート**: `9999`
- **ベースイメージ**: `python:3.10-slim`
- **実行環境**: Synology NAS (コンテナマネージャー)

### 主要機能
1. **配送ルート最適化**: OR-Toolsを使用したVRP（Vehicle Routing Problem）解決
2. **時間窓制約**: 各クライアントの訪問可能時間を考慮
3. **社員稼働時間**: 社員ごとの開始・終了時刻を設定
4. **昼休憩**: 11:00-15:00の間に60分の休憩を自動挿入
5. **優先順位**: クライアントの優先度に基づくペナルティ設定

### API仕様
- **エンドポイント**: `POST /`
- **入力**: JSON形式の配送データ
- **出力**: 最適化されたルート情報

## ファイル構成

```
my-ortools/
├── main.py              # OR-Tools APIサーバー
├── Dockerfile           # コンテナビルド設定
├── requirements.txt     # Python依存関係
├── docker-compose.yml   # コンテナオーケストレーション
├── code.js              # Google Apps Scriptメインコード
├── map.html             # ルート表示用HTML
├── CONTAINER-SETUP.md   # コンテナ設定手順
└── SYNOPSIS.md          # このファイル
```

## 開発環境

### ローカル開発
- **Git**: バージョン管理
- **GitHub**: リポジトリ管理
- **clasp**: Google Apps Script連携

### 本番環境
- **Synology NAS**: コンテナ実行環境
- **Google Apps Script**: ウェブアプリケーション
- **Google Drive**: データストレージ

## 更新履歴

### 2025年8月8日
- プロジェクト初期化
- GitHubリポジトリ作成
- コンテナ設定記録
- 開発環境セットアップ完了

## 次のステップ

1. **コンテナの動作確認**
2. **GAS連携テスト**
3. **機能拡張・改善**
4. **本番環境での運用開始**
