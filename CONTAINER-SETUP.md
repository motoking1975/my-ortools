# OR-Toolsコンテナ設定（Synologyコンテナマネージャー）

## 概要
Google Apps ScriptからOR-Toolsを使用した配送ルート最適化を行うPythonコンテナの設定です。

## コンテナ情報

### 基本設定
- **コンテナ名**: `ortools-vrp-server`
- **ポート**: `9999`
- **ベースイメージ**: `python:3.10-slim`
- **アプリケーション**: Flask + OR-Tools

### 依存関係
```
flask==2.2.3
functions-framework==3.0.0
ortools==9.11.4210
protobuf==5.26.1
werkzeug==2.2.3
```

## Synologyコンテナマネージャーでの設定手順

### 1. イメージの作成
1. **コンテナマネージャー**を開く
2. **イメージ**タブ → **追加** → **Dockerfileから作成**
3. **プロジェクトフォルダ**: `/volume1/docker/my-ortools`
4. **イメージ名**: `ortools-vrp:latest`
5. **作成**をクリック

### 2. コンテナの作成
1. **コンテナ**タブ → **追加** → **イメージから作成**
2. **イメージ**: `ortools-vrp:latest`
3. **コンテナ名**: `ortools-vrp-server`
4. **ポート設定**:
   - ローカルポート: `9999`
   - コンテナポート: `9999`
5. **環境変数**:
   - `PYTHONUNBUFFERED=1`
6. **自動再起動**: 有効
7. **作成**をクリック

### 3. ネットワーク設定
- **ネットワーク**: デフォルトブリッジネットワーク
- **IPアドレス**: 自動割り当て

## 動作確認

### コンテナ起動確認
```bash
# コンテナマネージャーでログを確認
# 正常起動時: "Starting Flask on port 9999" が表示される
```

### API動作確認
```bash
curl -X POST http://[Synology-IP]:9999/ \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

## GAS連携設定

### Google Apps Script側の設定
```javascript
const CF_URL = "http://[Synology-IP]:9999";
// または
const CF_URL = "https://tagdata.synology.me:9999";
```

## トラブルシューティング

### よくある問題
1. **ポート9999が使用中**: 別のポートに変更
2. **メモリ不足**: コンテナのメモリ制限を調整
3. **ネットワーク接続エラー**: ファイアウォール設定を確認

### ログ確認
- **コンテナマネージャー** → **コンテナ** → **ログ**タブ
- **リアルタイムログ**で動作状況を確認

## 更新手順

### コード更新時
1. **コンテナ停止**
2. **イメージ再作成**
3. **コンテナ再作成**（または更新）

### 設定変更時
1. **docker-compose.yml**を編集
2. **コンテナマネージャー**で設定を反映
3. **コンテナ再起動**
