/*******************************
 * 対象とする年月 (1～末日まで)
 *******************************/
const TARGET_YEAR = 2025;
const TARGET_MONTH = 8;

/*******************************
 * 社員ごとの稼働時間(6:00基準)
 *   start/end は 6:00=0分～21:00=900分 で指定
 *******************************/
const EMPLOYEE_TIME_RANGES = {
  "社員A": { start: 0, end: 780 },  // 8:00～21:00 (※コメントと実値ズレは元のまま)
  "社員B": { start: 0, end: 900 }, // 6:00～17:00 (同上)
  "社員C": { start: 0, end: 780 }, // 8:00～14:00 (同上)
  "社員D": { start: 0, end: 900 }, // 6:00～16:00 (コメントと実値ズレは元のまま)
  "社員E": { start: 0, end: 780 }, // 6:30～13:30 (コメントは元の例のまま、実際は start=180→9:00開始)
};

/********************************
 * 移動時間バッファ
 * (距離行列の値に上乗せするオフセット)
 ********************************/
const BUFFER_UNDER_5 = 3;        // 5分未満 → 0分
const BUFFER_5_TO_30 = 5;       // 5分以上30分未満 → +10分
const BUFFER_30_TO_59 = 7;      // 30分以上60分未満 → +10分
const BUFFER_60_OVER = 8;       // 60分以上 → +10分

// ★追加: 優先順位→ペナルティコスト のマップ
const PRIORITY_PENALTY_MAP = {
  1: 9999999, // 最重要
  2: 80000,
  3: 50000,
  4: 40000,
  5: 2000    // 空白も含め 5 相当
};

/********************************
 * ★訪問間隔の設定(営業日ベース)
 *  ※「元々の visits_needed」ごとに固定
 ********************************/
const VISIT_INTERVAL_4_OR_MORE = 4; // visits_needed4以上 => 常に5営業日
const VISIT_INTERVAL_3 = 6;
const VISIT_INTERVAL_2 = 7;

/********************************
 * 2人対応の最低訪問件数
 ********************************/
const MIN_TWO_PERSON_VISIT_COUNT = 3;

/**
 * 以下は「社員の定義例」です。
 * 今後社員数が増減したら、ここを調整すればOKです。
 */
// ◆全社員（参考用。実際には下の配列を使う）
const allEmployees = ["社員A", "社員B", "社員C", "社員D"];

// 例: 車両コスト(任意設定：今後使う場合はここを参照)
const vehicleCosts = [0, 0, 0, 0, 0];

/**
 * 2人対応用の社員
 */
const employeesFor2Person = ["社員D"];

/**
 * 1人対応用（当日 2人対応がある日の場合）
 */
const employeesFor1PersonIf2PersonExists = ["社員A", "社員B", "社員C"];

/**
 * 1人対応用（当日 2人対応が無い日の場合）
 */
const employeesFor1PersonIfNo2PersonExists = ["社員A", "社員B", "社員C", "社員D"];


/**
 * メイン関数: callOrtoolsFunction()
 *   1) シート「訪問予定調整」から条件を満たすクライアントを読み込み
 *   2) 全クライアントに対し nextEarliestDay=0 を初期設定
 *   3) 日付ごとに
 *        a) 「対応人数=2」のクライアントを抽出して OR-Tools 実行
 *        b) 「対応人数=1」のクライアントを抽出して OR-Tools 実行
 *   4) 解が得られたら visits_neededを減らし、0になったら当日の残り試行対象から外す
 *   5) 出力シートに書き込む + infeasibleログ出力
 */
function callOrtoolsFunction() {
  Logger.log("=== callOrtoolsFunction 開始 ===");
  const props = PropertiesService.getScriptProperties();

  // 必要プロパティ読み込み
  const API_KEY = props.getProperty("apiKey");
  const SSID = props.getProperty("SPREADSHEET_ID");
  // 結果出力用
  const SSID2 = props.getProperty("SPREADSHEET_ID_2"); // キャッシュ & 「訪問予定調整」
  if (!API_KEY || !SSID || !SSID2) {
    Logger.log("Missing => apiKey / SPREADSHEET_ID / SPREADSHEET_ID_2");
    return;
  }

  // Docker上のPython URL
  const CF_URL = "https://tagdata.synology.me";
  Logger.log("Docker-based Python URL: " + CF_URL);

  // 1) シート「訪問予定調整」からクライアントデータを取得
  Logger.log("Step1: シート「訪問予定調整」からクライアントデータ取得開始");
  const allClients = readRealClientData_(SSID2, "訪問予定調整");
  if (allClients.length === 0) {
    Logger.log("条件に合うクライアントがありません => stop.");
    return;
  }
  Logger.log("Step1完了 => 件数=" + allClients.length);

  // 2) visits_needed はシートから取得済み。nextEarliestDay=0 に初期化
  // 優先順位（priority）とIDで安定ソート
  allClients.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });

  /* ---▼ ここを新しく追加 ▼--- */
  // ❶ 営業日リストを先に作る
  const dayList = makeDateList_2025_04_01_04_30_skipWeekend();
  const totBusDays = dayList.length;          // 今月の営業日数

  // ❷ 各クライアントに intervalDays を付与
  for (let i = 0; i < allClients.length; i++) {
    const cl = allClients[i];
    cl.intervalDays = Math.ceil(totBusDays / cl.originalVisitsNeeded);   // ★動的間隔
    cl.nextEarliestDay = 0;                                                 // 必要なら + オフセット
  }
  // 日付一覧
  Logger.log("Step2: 日付一覧生成");
  Logger.log("dayList=" + JSON.stringify(dayList));

  Logger.log("Step3: 各日ループ開始 (全日数: " + dayList.length + ")");
  let finalData = []; // 日別の解(OR-Tools結果)を集約

  function addSolutionToFinalData(finalData, dayKey, newSolution) {
    let existing = finalData.find(d => d.day_key === dayKey);
    if (!existing) {
      finalData.push({
        day_key: dayKey,
        solution: newSolution
      });
    } else {
      existing.solution = existing.solution.concat(newSolution);
    }
  }

  for (let di = 0; di < dayList.length; di++) {
    let dayKey = dayList[di];
    Logger.log("=== Day=" + dayKey + " (index=" + di + ") 開始 ===");

    // 曜日判定
    let userDOW = calcUserDow(dayKey);

    // (A) visits_needed>0 && nextEarliestDay <= di のクライアントを抽出
    let preFilter = allClients.filter(cl => (cl.visits_needed > 0) && (cl.nextEarliestDay <= di));

    // (B) 当日 userDOW に合ったスケジュールがあるかどうか
    let remainClients = preFilter.filter(cl => {
      let scheduleMap = parseVisitSummary_(cl.visitSummary);
      return scheduleMap.hasOwnProperty(String(userDOW));
    });
    if (remainClients.length === 0) {
      Logger.log("Day=" + dayKey + ": 対象クライアントなし => スキップ");
      continue;
    }

    // 3-a) 2人対応
    let subset2 = remainClients.filter(c => c.peopleCount === 2);
    let twoPersonSolutions = [];

    if (subset2.length > 0) {
      Logger.log("Day=" + dayKey + ": 2人対応クライアントが " + subset2.length + "件 => (最大人数→1まで)で再試行アプローチ開始");
      twoPersonSolutions = solveIterativelyForTheDay_(
        subset2,
        employeesFor2Person,
        dayKey,
        di,
        CF_URL,
        API_KEY,
        true // 2人対応
      );
      if (twoPersonSolutions.length > 0) {
        addSolutionToFinalData(finalData, dayKey, twoPersonSolutions);
      }
    } else {
      Logger.log("Day=" + dayKey + ": 2人対応クライアントが 0件 => スキップ");
    }

    // 3-b) 1人対応の準備
    let subset1 = remainClients.filter(c => c.peopleCount === 1);

    // ✅ まず employees1 を先に宣言しておく（2人対応の後で上書きされるかも）
    let employees1 = employeesFor1PersonIfNo2PersonExists;

    // ✅ 2人対応が存在すれば、いったん社員Dを外す構成にする
    if (subset2.length > 0) {
      employees1 = employeesFor1PersonIf2PersonExists;
    }

    // ✅ さらに、2人対応がキャンセルされたなら社員Dを合流させる
    if (twoPersonSolutions.length === 0 && subset2.length > 0) {
      Logger.log("2人対応キャンセルのため、社員Dを1人対応に合流させます");
      employees1 = employeesFor1PersonIfNo2PersonExists;
    }

    if (subset1.length > 0) {
      Logger.log("Day=" + dayKey + ": 1人対応クライアントが " + subset1.length + "件 => (最大人数→1まで)で再試行アプローチ開始");

      let onePersonSolutions = solveIterativelyForTheDay_(
        subset1,
        employees1,
        dayKey,
        di,
        CF_URL,
        API_KEY,
        false
      );

      if (onePersonSolutions.length > 0) {
        addSolutionToFinalData(finalData, dayKey, onePersonSolutions);
      }
    } else {
      Logger.log("Day=" + dayKey + ": 1人対応クライアントが 0件 => スキップ");
    }

    Logger.log("=== Day=" + dayKey + " (index=" + di + ") 処理終了 ===");
  } // end dayList

  // ★追加: 出発拠点時刻を最初の訪問先と移動時間から逆算
  adjustDepartureTimesForFirstStop_(finalData);

  // 4) 出力: ルート結果シート
  Logger.log("Step4: ルート結果シートへ出力");
  writeRouteSheet_(finalData, SSID);

  // 5) 訪問しきれず (visits_needed>0) のクライアント
  let notVisited = allClients.filter(cl => cl.visits_needed > 0);
  if (notVisited.length > 0) {
    Logger.log("=== 訪問不可能(または残り)クライアント一覧 ===");
    notVisited.forEach(cl => {
      Logger.log("ID=" + cl.id + ", name=" + cl.name + " => visits=" + cl.visits_needed);
    });
  }

  // map 用
  const routeJson = JSON.stringify(finalData);
  PropertiesService.getScriptProperties().setProperty("LAST_ROUTE_DATA", routeJson);

  Logger.log("Done => see route => " + ScriptApp.getService().getUrl());

  // 保存・ログ
  const result = saveRouteDataToDriveWithTimestamp_(finalData);
  logRouteFileToSheet_(result.fileId, result.dateStr);

  // ★訪問不可客先一覧の追記処理
  const routeJsonStr = PropertiesService.getScriptProperties().getProperty("LAST_ROUTE_DATA");
  const routeJsonFromStorage = JSON.parse(routeJsonStr || "[]");

  const nameToDatesMap = {};
  routeJsonFromStorage.forEach(dayObj => {
    const dayKey = dayObj.day_key;
    (dayObj.solution || []).forEach(sol => {
      (sol.route || []).forEach(step => {
        const name = step.location_name;
        if (name && name !== "出発拠点" && name !== "到着拠点") {
          if (!nameToDatesMap[name]) nameToDatesMap[name] = [];
          nameToDatesMap[name].push(dayKey);
        }
      });
    });
  });

  const ss = SpreadsheetApp.openById(SSID);
  const sh = ss.getSheets().find(s => s.getName().startsWith("ルート結果_"));
  if (sh && notVisited.length > 0) {
    const startRow = sh.getLastRow() + 4;
    sh.getRange(startRow, 1, 1, 3).setValues([["訪問不可客先", "訪問日付", "残回数"]]);

    const data = notVisited.map(cl => {
      const dates = nameToDatesMap[cl.name] || [];
      return [cl.name, dates.join(","), cl.visits_needed];
    });

    if (data.length > 0) {
      sh.getRange(startRow + 1, 1, data.length, 3).setValues(data);
    }
  }


  Logger.log("個別マップURL: " +
    `https://script.google.com/macros/s/${ScriptApp.getScriptId()}/dev?fileId=${result.fileId}`);

  Logger.log("=== callOrtoolsFunction 完了 ===");

}


/**
 * ★修正ポイント含むメインロジック:
 *   指定された subsetTasks を
 *   「employees配列の最大人数」→「1人」まで減らしながら OR-Tools に渡し、
 *   解が得られたら その時に割り当てたタスクの visits_needed を減らし、
 *   visits_needed が 0 になったら当日の残り試行対象( taskPool )から除外。
 *   さらに社員も「実際に使われた社員」をプールから外しつつ繰り返す。
 */
function solveIterativelyForTheDay_(subsetTasks, employeesAll, dayKey, di, CF_URL, API_KEY, isTwoPerson) {
  let finalSolutions = [];
  let taskPool = subsetTasks.slice();    // 同日のタスク
  let empPool = employeesAll.slice();    // 同日の社員プール

  while (true) {
    // 更新( visits_needed > 0 ) のみ残す
    taskPool = taskPool.filter(t => t.visits_needed > 0);
    if (taskPool.length === 0) {
      Logger.log("タスクは全て割り当て済み => break");
      break;
    }
    if (empPool.length === 0) {
      Logger.log("社員が残っていません => 割り当て終了 (未割当あり)");
      break;
    }

    let usedSolution = null;
    let usedEmployees = [];

    // 最大人数から1人まで
    let successInThisRound = false;
    for (let tryCount = empPool.length; tryCount >= 1; tryCount--) {
      let usingEmp = empPool.slice(0, tryCount);

      Logger.log(
        (isTwoPerson ? "[2人対応]" : "[1人対応]") +
        ` OR-Tools試行: 社員数=${tryCount} (うち${empPool.length}人プール中) ⇒ day=${dayKey}`
      );

      let resultObj = runOrToolsOneShot_(
        dayKey,
        taskPool,
        usingEmp,
        CF_URL,
        API_KEY,
        isTwoPerson
      );

      if (resultObj && resultObj.status === "ok") {
        let solArr = resultObj.solution || [];
        if (solArr.length > 0) {

          if (isTwoPerson && solArr.reduce((acc, s) => acc + (s.route.length - 2), 0) <= MIN_TWO_PERSON_VISIT_COUNT) {
            Logger.log(`[2人対応] 訪問件数が${MIN_TWO_PERSON_VISIT_COUNT}件以下のためキャンセル（社員: ${solArr.map(s => s.employee).join(",")}）`);
            return [];
          }

          usedSolution = solArr;
          // ここで visits_needed-- して、0になったら taskPool から除外
          usedSolution.forEach(sol => {
            let routeSteps = sol.route || [];
            routeSteps.forEach(st => {
              if (st.location_name !== "出発拠点" && st.location_name !== "到着拠点") {
                let found = taskPool.find(c => c.name === st.location_name);
                if (found) {
                  found.visits_needed--;
                  if (found.visits_needed > 0) {
                    /* 固定間隔型（intervalDays は初期化済み） */
                    found.nextEarliestDay = di + found.intervalDays;
                  }
                }
              }
            });
          });

          // visits_needed <= 0 になったタスクは「当日の残り試行」から除外
          taskPool = taskPool.filter(t => t.visits_needed > 0);

          // ★追加: nextEarliestDay が当日を超えたタスクは「同じ日に2回訪問」されないよう除外
          taskPool = taskPool.filter(t => t.nextEarliestDay <= di);

          // ルートで実際に使われた社員
          let employeesUsedSet = new Set(solArr.map(s => s.employee));
          usedEmployees = Array.from(employeesUsedSet);

          // finalSolutionsに追加
          solArr.forEach(sol => finalSolutions.push(sol));

          successInThisRound = true;
          break;
        } else {
          Logger.log("⇒ solution配列が空 => 次の社員数を試す");
        }
      } else {
        Logger.log("⇒ solutionエラー or infeasible => 次の社員数を試す");
      }
    }

    if (!successInThisRound) {
      Logger.log("人数を下げても解が得られず => この日の割り当て打ち切り");
      break;
    }

    if (usedEmployees.length > 0) {
      // 今回使われた社員をプールから除外
      empPool = empPool.filter(e => !usedEmployees.includes(e));
      Logger.log("今回使われた社員: " + JSON.stringify(usedEmployees) + " ⇒ プールから除外");
    }
  }

  return finalSolutions;
}


/**
 * OR-Tools 1回呼び出し
 */
function runOrToolsOneShot_(dayKey, tasks, employees, CF_URL, API_KEY, isTwoPerson) {
  let latlngs = [{ lat: 35.7501747, lng: 139.7129978 }];
  tasks.forEach(cl => {
    let lat = 35.75, lng = 139.60;
    try {
      let [la, ln] = cl.address.split(",");
      lat = parseFloat(la);
      lng = parseFloat(ln);
    } catch (e) { /* ignore */ }
    latlngs.push({ lat, lng });
  });

  let distMat = buildDistMatrixWithCache_(latlngs, API_KEY);
  applyTravelTimeBuffer_(distMat);

  const employeeTimeWindows = employees.map(emp => {
    const r = EMPLOYEE_TIME_RANGES[emp] || { start: 0, end: 900 };
    return { start: r.start, end: r.end };
  });

  tasks.forEach(cl => {
    let scheduleMap = parseVisitSummary_(cl.visitSummary);
    cl.scheduleWindows = scheduleMap;
  });

  // vehicle_costs は社員数ぶん用意
  let vehicle_cost_arr = employees.map((_, idx) => {
    if (idx === 0) return 0;
    if (idx === 1) return 100;
    if (idx === 2) return 1000;
    if (idx === 3) return 10000;
    return 10000;
  });

  let payload = {
    employees: employees,
    clients: tasks,
    day_key: dayKey,
    vehicle_costs: vehicle_cost_arr,
    max_vehicle_capacity: 7,
    workday_length: 900,
    employee_time_windows: employeeTimeWindows,
    dist_matrix: distMat,
    depot_lat: 35.7499889,
    depot_lng: 139.7129978,
    chunk_size: 25,
    use_disjunction: true,
    penalty_cost: 30000,
    time_limit_seconds: 15,
    first_solution_strategy: "AUTOMATIC",
    local_search_metaheuristic: "AUTOMATIC",
    priority_penalty_map: PRIORITY_PENALTY_MAP,
    enable_lunch_break: true
  };

  let opt = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let respObj = {
    status: "error",
    solution: [],
    infeasible_clients: []
  };

  try {
    let resp = UrlFetchApp.fetch(CF_URL, opt);
    let code = resp.getResponseCode();
    Logger.log("HTTPレスポンス(" + (isTwoPerson ? "2人対応" : "1人対応") + ")=" + code);

    if (code === 200) {
      let jsn = JSON.parse(resp.getContentText() || "{}");
      Logger.log("status(" + (isTwoPerson ? "2人対応" : "1人対応") + ")=" + jsn.status);

      if (jsn.status === "error") {
        Logger.log("=== Python側でエラー発生(" + (isTwoPerson ? "2人対応" : "1人対応") + ") ===");
        Logger.log("error_message: " + jsn.error_message);
        Logger.log("traceback: " + jsn.traceback);
      }
      else if (jsn.status === "ok") {
        respObj.status = "ok";
        respObj.solution = jsn.solution || [];
        respObj.infeasible_clients = jsn.infeasible_clients || [];
      }

      if (jsn.infeasible_clients) {
        Logger.log("訪問不可能クライアント: " + JSON.stringify(jsn.infeasible_clients));
        respObj.infeasible_clients = jsn.infeasible_clients;
      }
    } else {
      Logger.log("HTTPエラー code=" + code);
      Logger.log(resp.getContentText());
    }

  } catch (e) {
    Logger.log("例外発生 => " + e);
  }

  Utilities.sleep(500);
  return respObj;
}


/**
 * 「訪問予定まとめコード」パース関数
 */
function parseVisitSummary_(summaryStr) {
  let outMap = {};
  if (!summaryStr) return outMap;
  let arr = summaryStr.split("/");
  arr.forEach(part => {
    let p = part.trim();
    if (!p) return;
    let plusIdx = p.indexOf("+");
    if (plusIdx < 0) return;
    let dayStr = p.substring(0, plusIdx);
    let restStr = p.substring(plusIdx + 1);
    let dashIdx = restStr.indexOf("-");
    if (dashIdx < 0) return;

    let stStr = restStr.substring(0, dashIdx);
    let enStr = restStr.substring(dashIdx + 1);
    let dayNum = parseInt(dayStr, 10);

    // 6:00基準に変更
    let [stH, stM] = stStr.split(":");
    let [enH, enM] = enStr.split(":");
    let stMin = ((+stH || 0) * 60 + (+stM || 0)) - 6 * 60;
    let enMin = ((+enH || 0) * 60 + (+enM || 0)) - 6 * 60;

    if (stMin < 0) stMin = 0;
    if (enMin > 900) enMin = 900;
    if (stMin >= enMin) {
      Logger.log("parseVisitSummary_ 警告: 不正な時間範囲 => " + p);
      return;
    }
    outMap[dayNum.toString()] = [stMin, enMin];
  });
  return outMap;
}


/**
 * 距離行列生成(キャッシュ利用)
 */
let gDistCacheMap = null;
function buildDistMatrixWithCache_(latlngs, apiKey) {
  Logger.log("buildDistMatrixWithCache_ => latlngs.length=" + latlngs.length);
  if (!gDistCacheMap) {
    gDistCacheMap = loadDistCacheToMap_();
  }

  const n = latlngs.length;
  let mat = Array(n).fill(0).map(() => Array(n).fill(0));
  let pendingRequests = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        mat[i][j] = 0;
      } else {
        let fromObj = latlngs[i];
        let toObj = latlngs[j];
        let distMin = tryGetCacheDistance_(fromObj.lat, fromObj.lng, toObj.lat, toObj.lng);
        if (distMin !== null) {
          mat[i][j] = distMin;
        } else {
          pendingRequests.push({
            fromIdx: i,
            toIdx: j,
            fromLat: +fromObj.lat.toFixed(5),
            fromLng: +fromObj.lng.toFixed(5),
            toLat: +toObj.lat.toFixed(5),
            toLng: +toObj.lng.toFixed(5)
          });
        }
      }
    }
  }

  if (pendingRequests.length > 0) {
    Logger.log("Cache miss count=" + pendingRequests.length + " => Haversine近似計算を実行");

    let chunkSize = 50;
    let total = pendingRequests.length;
    let ssId2 = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID_2");
    let ss = SpreadsheetApp.openById(ssId2);
    let sh = ss.getSheetByName("距離マトリックス");
    if (!sh) {
      sh = ss.insertSheet("距離マトリックス");
      sh.appendRow(["fromLat", "fromLng", "toLat", "toLng", "distanceMin", "近似計算"]);
    }

    for (let start = 0; start < total; start += chunkSize) {
      let end = Math.min(start + chunkSize, total);
      let chunkIndex = Math.floor(start / chunkSize) + 1;
      Logger.log("Haversine chunk #" + chunkIndex + " => " + (start + 1) + " - " + end + " / " + total);

      let chunk = pendingRequests.slice(start, end);
      let rowsToAppend = [];

      chunk.forEach(rq => {
        let dMin = computeHaversine_(rq.fromLat, rq.fromLng, rq.toLat, rq.toLng);
        mat[rq.fromIdx][rq.toIdx] = dMin;
        let key = makeDistKey_(rq.fromLat, rq.fromLng, rq.toLat, rq.toLng);
        gDistCacheMap[key] = dMin;
        rowsToAppend.push([
          rq.fromLat, rq.fromLng,
          rq.toLat, rq.toLng,
          dMin, "ON"
        ]);
      });

      if (rowsToAppend.length > 0) {
        sh.getRange(sh.getLastRow() + 1, 1, rowsToAppend.length, 6).setValues(rowsToAppend);
      }
    }
  }

  return mat;
}


/**
 * Haversine公式による近似移動時間(分)
 */
function computeHaversine_(lat1, lon1, lat2, lon2) {
  const R = 6371;
  function toRad(deg) { return deg * Math.PI / 180; }
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
    * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = R * c;
  let minutesPerKm = 2.0; // 時速30km/h => 1kmあたり2分
  let travelMin = distanceKm * minutesPerKm;
  return Math.round(travelMin);
}


/**
 * キャッシュ読み込み
 */
function loadDistCacheToMap_() {
  let mapObj = {};
  let ssId2 = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID_2");
  let ss = SpreadsheetApp.openById(ssId2);
  let sh = ss.getSheetByName("距離マトリックス");
  if (!sh) {
    sh = ss.insertSheet("距離マトリックス");
    sh.appendRow(["fromLat", "fromLng", "toLat", "toLng", "distanceMin", "近似計算"]);
    gDistCacheMap = mapObj;
    return gDistCacheMap;
  }
  let vals = sh.getDataRange().getValues();
  if (vals.length < 2) {
    gDistCacheMap = mapObj;
    return gDistCacheMap;
  }
  for (let r = 1; r < vals.length; r++) {
    let row = vals[r];
    let key = makeDistKey_(+row[0], +row[1], +row[2], +row[3]);
    mapObj[key] = +row[4];
  }
  Logger.log("loadDistCacheToMap_ => loaded count=" + (vals.length - 1));
  gDistCacheMap = mapObj;
  return gDistCacheMap;
}


/**
 * キャッシュ問い合わせ
 */
function tryGetCacheDistance_(fromLat, fromLng, toLat, toLng) {
  let key = makeDistKey_(fromLat, fromLng, toLat, toLng);
  let val = gDistCacheMap[key];
  if (val === undefined) return null;
  return val;
}

function makeDistKey_(fLa, fLo, tLa, tLo) {
  return [fLa.toFixed(5), fLo.toFixed(5), tLa.toFixed(5), tLo.toFixed(5)].join(",");
}


/**
 * ルート結果をシートに出力
 */
function writeRouteSheet_(daysArr, ssId) {
  Logger.log("writeRouteSheet_ => SSID=" + ssId);
  const ss = SpreadsheetApp.openById(ssId);

  const now = new Date();

  // ✅ 年月と作成日の書式を整える
  const year = TARGET_YEAR;
  const month = TARGET_MONTH;
  const createdStr = Utilities.formatDate(now, "Asia/Tokyo", "yyyy/MM/dd HH:mm");

  // ✅ ご希望のシート名形式に変更
  const shName = `ルート結果_${year}年${month}月(${createdStr}作成)`;

  const sh = ss.insertSheet(shName);
  sh.appendRow([
    "社員", "日付", "訪問順", "場所", "到着時刻", "出発時刻",
    "移動(分)", "滞在(分)", "lat", "lng"
  ]);

  let rows = [];

  daysArr.forEach(dObj => {
    let dy = dObj.day_key;
    (dObj.solution || []).forEach(sol => {
      let emp = sol.employee;
      let route = sol.route || [];
      let breaks = sol.breaks || [];

      let events = [];

      route.forEach(st => {
        let arrVal = parseHHMM_(st.time);
        let depVal = arrVal + (st.stay_min || 0);
        events.push({
          type: "node",
          arrival: arrVal,
          departure: depVal,
          name: st.location_name || "",
          trav: st.travel_minutes || 0,
          lat: st.lat,
          lng: st.lng
        });
      });

      breaks.forEach(br => {
        events.push({
          type: "break",
          arrival: br.start,
          departure: br.end,
          name: "昼休憩",
          trav: 0,
          lat: 0,
          lng: 0
        });
      });

      events.sort((a, b) => a.arrival - b.arrival);

      events.forEach((ev, i) => {
        let arrBase = (6 * 60) + ev.arrival;
        let depBase = (6 * 60) + ev.departure;
        let arrStr = ("0" + Math.floor(arrBase / 60)).slice(-2) + ":" + ("0" + (arrBase % 60)).slice(-2);
        let depStr = ("0" + Math.floor(depBase / 60)).slice(-2) + ":" + ("0" + (depBase % 60)).slice(-2);
        let stayMin = ev.departure - ev.arrival;

        rows.push([
          emp,
          dy,
          i,
          ev.name,
          arrStr,
          depStr,
          ev.trav,
          stayMin,
          ev.lat,
          ev.lng
        ]);
      });

    });
  });

  if (rows.length > 0) {
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }

  Logger.log("writeRouteSheet_ => rows=" + rows.length);
}



/**
 * "到着時刻"文字列 → 6:00基準の分
 */
function parseHHMM_(t) {
  let [hh, mm] = (t || "06:00").split(":");
  let H = parseInt(hh, 10) || 6;
  let M = parseInt(mm, 10) || 0;
  return (H * 60 + M) - (6 * 60);
}

/**
 * 6:00基準の「分」 → "HH:MM"
 */
function minToHHMM_(val) {
  let base = (6 * 60) + val;
  let hh = Math.floor(base / 60);
  let mm = base % 60;
  return ("0" + hh).slice(-2) + ":" + ("0" + mm).slice(-2);
}


/**
 * doGet => map(描画用HTML)
 */
function doGet(e) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("apiKey") || "";
  const fileId = (e && e.parameter && e.parameter.fileId) || "";
  let dataStr = "[]";

  if (fileId) {
    try {
      const file = DriveApp.getFileById(fileId);
      const blob = file.getBlob();
      dataStr = blob.getDataAsString();
    } catch (error) {
      console.error("ファイル読み込み失敗: ", error);
      return HtmlService.createHtmlOutput("<h3>指定されたファイルが見つかりません。</h3>")
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
  } else {
    // fallback to LAST_ROUTE_DATA
    const last = PropertiesService.getScriptProperties().getProperty("LAST_ROUTE_DATA");
    if (last) dataStr = last;
  }

  const tpl = HtmlService.createTemplateFromFile("map");
  tpl.apiKey = apiKey;
  tpl.routeDataJson = dataStr;

  return tpl.evaluate()
    .setTitle("ルートマップ")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}




/**
 * シート「訪問予定調整」読み込み
 */
function readRealClientData_(ssId2, sheetName) {
  Logger.log("=== readRealClientData_ (from '訪問予定調整') 開始 ===");
  const ss2 = SpreadsheetApp.openById(ssId2);
  const sh2 = ss2.getSheetByName(sheetName);
  if (!sh2) {
    Logger.log("Sheet not found => " + sheetName);
    return [];
  }

  const vals2 = sh2.getDataRange().getValues();
  if (vals2.length < 2) {
    Logger.log("No data => length=" + vals2.length + ", sheet=" + sheetName);
    return [];
  }
  const hdr2 = vals2[0];
  Logger.log("訪問予定調整 Header => " + JSON.stringify(hdr2));

  const idx_idContract = hdr2.indexOf("ID契約");
  const idx_name = hdr2.indexOf("契約名");
  const idx_summary = hdr2.indexOf("訪問予定まとめコード");
  const idx_coord = hdr2.indexOf("座標");
  const idx_status = hdr2.indexOf("契約状況");
  const idx_visits = hdr2.indexOf("訪問回数");
  const idx_allCompany = hdr2.indexOf("ALL担当会社");
  const idx_stayTime = hdr2.indexOf("滞在時間");
  const idx_priority = hdr2.indexOf("優先順位");
  const idx_peopleCount = hdr2.indexOf("対応人数");
  const idx_excludeSystem = hdr2.indexOf("システム除外");

  if (
    idx_idContract < 0 ||
    idx_name < 0 ||
    idx_summary < 0 ||
    idx_coord < 0 ||
    idx_status < 0 ||
    idx_visits < 0 ||
    idx_allCompany < 0 ||
    idx_stayTime < 0
  ) {
    Logger.log("必要な列が不足 => ID契約/契約名/訪問予定まとめコード/座標/契約状況/訪問回数/ALL担当会社/滞在時間");
    return [];
  }

  let outArr = [];
  for (let r = 1; r < vals2.length; r++) {
    let row = vals2[r];
    let cid = String(row[idx_idContract] || "").trim();
    let nm = String(row[idx_name] || "").trim();
    let vsum = String(row[idx_summary] || "").trim();
    let coord = String(row[idx_coord] || "").trim();
    let stat = String(row[idx_status] || "").trim();
    let vcountRaw = String(row[idx_visits] || "").trim();
    let allComp = String(row[idx_allCompany] || "").trim();
    let stayRaw = row[idx_stayTime];
    let stayVal = parseInt(stayRaw, 10) || 30;

    let priorityVal = 5;
    if (idx_priority >= 0) {
      let pRaw = String(row[idx_priority] || "").trim();
      if (pRaw !== "") {
        priorityVal = parseInt(pRaw, 10) || 5;
      }
    }

    let peopleCount = 1;
    if (idx_peopleCount >= 0) {
      let pcRaw = String(row[idx_peopleCount] || "").trim();
      if (pcRaw !== "") {
        peopleCount = parseInt(pcRaw, 10) || 1;
      }
    }
    if (idx_excludeSystem >= 0) {
      let excludeVal = String(row[idx_excludeSystem] || "").trim();
      if (excludeVal === "ON") {
        continue;
      }
    }
    if (!cid || !nm || !vsum || !coord || !stat || !vcountRaw || !allComp) {
      continue;
    }
    if (stat !== "継続中" && stat !== "終了予定") {
      continue;
    }
    if (allComp.indexOf("東京アクアガーデン") < 0) {
      continue;
    }

    let vcount = parseInt(vcountRaw, 10) || 1;
    outArr.push({
      id: cid,
      name: nm,
      address: coord,
      status: stat,
      visitSummary: vsum,
      visits_needed: vcount,
      originalVisitsNeeded: vcount,
      nextEarliestDay: 0,
      stay_min: stayVal,
      priority: priorityVal,
      peopleCount: peopleCount
    });
  }

  Logger.log("readRealClientData_ => length=" + outArr.length);
  if (outArr.length > 0) {
    Logger.log("先頭クライアント例: " + JSON.stringify(outArr[0]));
  }
  return outArr;
}


/**
 * 旧: 2025-04-01～04-30 (土日除く)
 * 今: 指定年月 TARGET_YEAR / TARGET_MONTH の範囲内(土日と当社休日を除く)
 */
function makeDateList_2025_04_01_04_30_skipWeekend() {
  Logger.log("makeDateList_2025_04_01_04_30_skipWeekend 開始");
  const holidaySet = readCompanyHolidayDays_(TARGET_YEAR, TARGET_MONTH);

  let lastDay = new Date(TARGET_YEAR, TARGET_MONTH, 0).getDate();
  let out = [];
  for (let day = 1; day <= lastDay; day++) {
    let d = new Date(TARGET_YEAR, TARGET_MONTH - 1, day);
    let w = d.getDay(); // 0=日,6=土
    if (w === 0 || w === 6) continue;
    if (holidaySet.has(day)) continue;
    let y = d.getFullYear();
    let m = ("0" + (d.getMonth() + 1)).slice(-2);
    let dd = ("0" + d.getDate()).slice(-2);
    out.push(`${y}-${m}-${dd}`);
  }
  Logger.log("makeDateList_2025_04_01_04_30_skipWeekend 完了 => " + JSON.stringify(out));
  return out;
}


/**
 * 当社休日シート読み込み
 */
function readCompanyHolidayDays_(year, month) {
  Logger.log("readCompanyHolidayDays_ => year=" + year + ", month=" + month);
  const holidaySet = new Set();

  const props = PropertiesService.getScriptProperties();
  const ssId4 = props.getProperty("SPREADSHEET_ID_4");
  if (!ssId4) {
    Logger.log("SPREADSHEET_ID_4 が未設定です。");
    return holidaySet;
  }

  let ss = SpreadsheetApp.openById(ssId4);
  let sh = ss.getSheetByName("当社の休日");
  if (!sh) {
    Logger.log("シート『当社の休日』が見つかりません");
    return holidaySet;
  }

  let vals = sh.getDataRange().getValues();
  if (vals.length < 2) {
    Logger.log("当社の休日シート: データがありません");
    return holidaySet;
  }

  let hdr = vals[0];
  let idx_holidayDate = hdr.indexOf("休日日付");
  if (idx_holidayDate < 0) {
    Logger.log("当社の休日シート: 『休日日付』列が見つかりません");
    return holidaySet;
  }

  for (let i = 1; i < vals.length; i++) {
    let row = vals[i];
    let rawDate = String(row[idx_holidayDate] || "").trim();
    if (!rawDate) continue;
    let dt = new Date(rawDate);
    if (isNaN(dt.getTime())) continue;
    if (dt.getFullYear() === year && dt.getMonth() === (month - 1)) {
      holidaySet.add(dt.getDate());
    }
  }

  Logger.log("当社の休日: 取得件数=" + holidaySet.size + " => " + JSON.stringify(Array.from(holidaySet)));
  return holidaySet;
}


/**
 * 曜日→ユーザ定義(1=日,2=月,...7=土)
 */
function calcUserDow(dayKey) {
  let dt = new Date(dayKey + "T00:00:00");
  let w = dt.getDay(); // 0=日
  const map_dow = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
  return map_dow[w];
}


/**
 * distMat にバッファ上乗せ
 */
function applyTravelTimeBuffer_(distMat) {
  let n = distMat.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let d = distMat[i][j];
      if (d < 5) {
        distMat[i][j] = d + BUFFER_UNDER_5;
      } else if (d < 30) {
        distMat[i][j] = d + BUFFER_5_TO_30;
      } else if (d < 60) {
        distMat[i][j] = d + BUFFER_30_TO_59;
      } else {
        distMat[i][j] = d + BUFFER_60_OVER;
      }
    }
  }
}

/**
 * ★追加関数:
 *   「最初の訪問先の到着時刻 - travel_minutes」 を元に、出発拠点の出発時刻を上書きする
 *   例）最初の訪問先が 10:00 到着、移動 30分 → 出発拠点は 9:30 に書き換え
 */
function adjustDepartureTimesForFirstStop_(daysArr) {
  Logger.log("=== adjustDepartureTimesForFirstStop_ 開始 ===");
  daysArr.forEach(dayObj => {
    (dayObj.solution || []).forEach(empSol => {
      let rt = empSol.route || [];
      if (rt.length < 2) return; // 出発拠点＋到着拠点のみ or 空
      // rt[0] が出発拠点、rt[1] が最初の訪問先
      let first = rt[1];
      let arrMin = parseHHMM_(first.time);       // 最初の訪問先の「到着時刻」
      let travMin = first.travel_minutes || 0;   // 出発拠点→最初の訪問先の移動
      let newDep = arrMin - travMin;             // 出発拠点の出発時刻 (6:00基準分)
      if (newDep < 0) {
        // もし 0 より小さくなったら 6:00 としておく
        newDep = 0;
      }
      // 書き換え
      rt[0].time = minToHHMM_(newDep);
    });
  });
  Logger.log("=== adjustDepartureTimesForFirstStop_ 終了 ===");
}

function saveRouteDataToDriveWithTimestamp_(routeData) {
  const folderId = "1qR0VNEs1fqIp1JfehY2wxNB_BJzJoMbs";
  const folder = DriveApp.getFolderById(folderId);
  const now = new Date();
  const y = now.getFullYear();
  const m = ("0" + (now.getMonth() + 1)).slice(-2);
  const d = ("0" + now.getDate()).slice(-2);
  const hh = ("0" + now.getHours()).slice(-2);
  const mm = ("0" + now.getMinutes()).slice(-2);
  const timestamp = `${y}-${m}-${d}_${hh}${mm}`;
  const fileName = `route_${timestamp}.json`;

  const jsonText = JSON.stringify(routeData, null, 2);
  const file = folder.createFile(fileName, jsonText, MimeType.PLAIN_TEXT);

  //  グループ内（ドメイン内）だけ閲覧可能にする
  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);

  return { fileId: file.getId(), dateStr: timestamp };
}


function logRouteFileToSheet_(fileId, dateStr) {
  const ss = SpreadsheetApp.openById("12F7MCiSJcwJdxqcjhwT1miwDvH4EwhtXuRWrC7blLbc");
  const sh = ss.getSheetByName("ルートマップ") || ss.insertSheet("ルートマップ");

  // ヘッダーが無い場合は追加
  if (sh.getLastRow() === 0) {
    sh.appendRow(["作成日時", "表示URL", "対象年月"]);
  }

  const now = new Date();
  const props = PropertiesService.getScriptProperties();
  const deploymentId = props.getProperty("DEPLOYMENT_ID");  // ここに AKf... を格納済み

  // ✅ 固定ドメイン付き形式でURLを構築
  const routeUrl = `https://script.google.com/a/aquagarden.info/macros/s/${deploymentId}/dev?fileId=${fileId}`;
  const targetYm = `${TARGET_YEAR}年${("0" + TARGET_MONTH).slice(-2)}月`;

  sh.appendRow([
    Utilities.formatDate(now, "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss"),
    routeUrl,
    targetYm
  ]);
}
