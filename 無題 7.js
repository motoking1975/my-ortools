function testFlaskAccess() {
  const response = UrlFetchApp.fetch("https://tagdata.synology.me", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ test: "hello" }),
    muteHttpExceptions: true
  });
  Logger.log("Status Code: " + response.getResponseCode());
  Logger.log("Body: " + response.getContentText());
}
