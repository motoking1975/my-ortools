function callPythonAPI() {
  // 1) Python+Flask のエンドポイント
  const url = "https://tagdata.synology.me"; // ← あなたの環境に合わせる

  // 2) リクエスト用データ (9:00スタート固定 + 660分以降にかかる移動時間)
  const payload = {
    distance_matrix: [
      [0,   200, 300],
      [200,   0, 250],
      [300, 250,   0]
    ],
    time_windows: [
      [540, 540],   // ノード0(デポ)は 9:00固定
      [540, 1440],  // ノード1は 9:00〜24:00
      [540, 1440]   // ノード2は 9:00〜24:00
    ],
    num_vehicles: 1,
    depot: 0
  };

  // 3) リクエスト送信
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload)
  };
  const response = UrlFetchApp.fetch(url, options);
  Logger.log(response.getContentText());

  // 4) 結果をパース
  const json = JSON.parse(response.getContentText());
  const routes = json.results || [];

  // 5) 移動時間 + サービス時間 だけなら何分後に到着するはずか？
  //    → 実際の到着時刻とのズレが「余剰休憩時間」
  for (let v = 0; v < routes.length; v++) {
    const vehicle = routes[v];
    const route   = vehicle.route;
    Logger.log("----- Vehicle " + vehicle.vehicle_id + " -----");

    for (let i = 0; i < route.length - 1; i++) {
      const currNode = route[i].location;
      const currTime = route[i].time;
      const nextNode = route[i+1].location;
      const nextTime = route[i+1].time;

      // distance_matrix[currNode][nextNode] + サービス時間(=10) を加算しただけなら
      // 到着時刻は "currTime + distance + 10" のはず
      const distance = payload.distance_matrix[currNode][nextNode];
      const expectedArrival = currTime + distance + 10;

      // 実際の到着時刻 (nextTime) とのズレ
      const diff = nextTime - expectedArrival;

      Logger.log(
        "Move from " + currNode + " to " + nextNode
        + " | CurrTime="+currTime
        + " | NextTime="+nextTime
        + " | Distance="+distance
        + " | ExpectedArrival="+expectedArrival
        + " | Diff="+diff
      );
    }

    // もし breaks[] が取得できた場合 (OR-Tools 9.7+)
    if (vehicle.breaks && vehicle.breaks.length > 0) {
      Logger.log("Break intervals => " + JSON.stringify(vehicle.breaks));
    }
  }
}
