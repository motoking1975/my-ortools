function testCallSynology() {
  const url = "https://tagdata.synology.me/"; // リバースプロキシ設定に合わせる (/myappなど)
  
  // もしBasic認証があるなら:
  // const username = "synouser";
  // const password = "synopass";
  // const basicAuth = "Basic " + Utilities.base64Encode(username + ":" + password);
  
  const options = {
    method: "get",
    // headers: { "Authorization": basicAuth }, // 認証が必要ならここをアンコメント
    muteHttpExceptions: true
  };
  const resp = UrlFetchApp.fetch(url, options);
  
  Logger.log("Response code: " + resp.getResponseCode());
  Logger.log("Body: " + resp.getContentText());
}
