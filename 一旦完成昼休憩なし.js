// /*******************************
//  * 対象とする年月 (1～末日まで)
//  *******************************/
// const TARGET_YEAR = 2025;
// const TARGET_MONTH = 6;

// /*******************************
//  * 社員ごとの稼働時間(6:00基準)
//  *   start/end は 6:00=0分～21:00=900分 で指定
//  *******************************/
// const EMPLOYEE_TIME_RANGES = {
//   "社員A": { start: 30, end: 780 },  // 8:00～21:00 (※コメントと実値ズレは元のまま)
//   "社員B": { start: 150, end: 900 }, // 6:00～17:00 (同上)
//   "社員C": { start: 150, end: 780 },  // 8:00～14:00 (同上)
//   // 修正箇所: コメントどおり6:00～16:00(=0～600)に合わせる
//   "社員D": { start: 0, end: 900 },   // 6:00～16:00 (コメントと実値ズレは元のまま)
//   "社員E": { start: 180, end: 780 }, // 6:30～13:30 (コメントは元の例のまま、実際は start=180→9:00開始)
// };

// /********************************
//  * 移動時間バッファ
//  * (距離行列の値に上乗せするオフセット)
//  ********************************/
// const BUFFER_UNDER_30 = 10;  // 30分未満の場合に+10分
// const BUFFER_30_59 = 5;      // 30分以上60分未満の場合に+5分
// const BUFFER_60_OVER = 3;    // 60分以上の場合に+3分

// // ★追加: 優先順位→ペナルティコスト のマップ
// const PRIORITY_PENALTY_MAP = {
//   1: 150000, // 最重要
//   2: 80000,
//   3: 50000,
//   4: 40000,
//   5: 2000    // 空白も含め 5 相当
// };

// /********************************
//  * ★訪問間隔の設定(営業日ベース)
//  *  ※「元々の visits_needed」ごとに固定
//  ********************************/
// const VISIT_INTERVAL_4_OR_MORE = 5; // visits_needed4以上 => 常に5営業日
// const VISIT_INTERVAL_3 = 6;        // visits_needed3 => 常に8営業日
// const VISIT_INTERVAL_2 = 7;        // visits_needed2 => 常に10営業日

// /**
//  * 以下は「社員の定義例」です。
//  * 今後社員数が増減したら、ここを調整すればOKです。
//  */
// // ◆全社員（参考用。実際には下の配列を使う）
// const allEmployees = ["社員A", "社員B", "社員C", "社員D", "社員E"];

// // 例: 車両コスト(任意設定：今後使う場合はここを参照)
// const vehicleCosts = [0, 100, 1000, 10000, 99999];

// /**
//  * 2人対応用の社員
//  *   - 現状は社員Dしか使わない設定
//  */
// const employeesFor2Person = ["社員D"];

// /**
//  * 1人対応用（当日 2人対応がある日の場合）
//  *   - 2人対応がある日は社員Dが専属になるので、D以外 + Eを使う例
//  */
// const employeesFor1PersonIf2PersonExists = ["社員A", "社員B", "社員C", "社員E"];

// /**
//  * 1人対応用（当日 2人対応が無い日の場合）
//  *   - 社員Dも含め全員から割当可能
//  */
// const employeesFor1PersonIfNo2PersonExists = ["社員A", "社員B", "社員C", "社員D", "社員E"];


// /**
//  * メイン関数: callOrtoolsFunction()
//  *   1) シート「訪問予定調整」から条件を満たすクライアントを読み込み
//  *   2) 全クライアントに対し nextEarliestDay=0 を初期設定
//  *   3) 日付ごとに
//  *        a) 「対応人数=2」のクライアントだけを抽出して「社員Dのみ」で OR-Tools 実行
//  *        b) 続けて「対応人数=1」のクライアントを抽出して「(A/B/C/E) もしくは (A/B/C/D/E)」で OR-Tools 実行
//  *      (社員Dが当日2人対応した場合、同日に1人対応は担当しない)
//  *   4) 解が得られたら visits_neededを減らし、まだ残る場合は設定された訪問間隔をあける
//  *   5) 出力シートに書き込む + infeasibleログ出力
//  */
// function callOrtoolsFunction() {
//   Logger.log("=== callOrtoolsFunction 開始 ===");
//   const props = PropertiesService.getScriptProperties();

//   // 必要プロパティ読み込み
//   const API_KEY = props.getProperty("apiKey");
//   const SSID = props.getProperty("SPREADSHEET_ID");
//   // 結果出力用
//   const SSID2 = props.getProperty("SPREADSHEET_ID_2"); // キャッシュ & 「訪問予定調整」
//   if (!API_KEY || !SSID || !SSID2) {
//     Logger.log("Missing => apiKey / SPREADSHEET_ID / SPREADSHEET_ID_2");
//     return;
//   }

//   // Docker上のPython URL
//   const CF_URL = "https://tagdata.synology.me";
//   Logger.log("Docker-based Python URL: " + CF_URL);

//   // 1) シート「訪問予定調整」からクライアントデータを取得
//   Logger.log("Step1: シート「訪問予定調整」からクライアントデータ取得開始");
//   const allClients = readRealClientData_(SSID2, "訪問予定調整");
//   if (allClients.length === 0) {
//     Logger.log("条件に合うクライアントがありません => stop.");
//     return;
//   }
//   Logger.log("Step1完了 => 件数=" + allClients.length);

//   // 2) visits_needed はシートから取得済み。nextEarliestDay=0 に初期化
//   Logger.log("Step2: nextEarliestDay を初期化し、クライアントリストをシャッフル");
//   shuffleArray(allClients);
//   for (let i = 0; i < allClients.length; i++) {
//     allClients[i].nextEarliestDay = 0;
//   }

//   // 日付一覧(指定した年月: TARGET_YEAR / TARGET_MONTH)
//   Logger.log("Step2: 日付一覧生成");
//   const dayList = makeDateList_2025_04_01_04_30_skipWeekend();
//   Logger.log("dayList=" + JSON.stringify(dayList));

//   Logger.log("Step3: 各日ループ開始 (全日数: " + dayList.length + ")");
//   let finalData = []; // 日別の解(OR-Tools結果)を集約

//   // ★同じ day_key の solution をまとめるヘルパー
//   function addSolutionToFinalData(finalData, dayKey, newSolution) {
//     let existing = finalData.find(d => d.day_key === dayKey);
//     if (!existing) {
//       finalData.push({
//         day_key: dayKey,
//         solution: newSolution
//       });
//     } else {
//       existing.solution = existing.solution.concat(newSolution);
//     }
//   }

//   // 3) 各日ごとに最大2回 OR-Tools を回す
//   for (let di = 0; di < dayList.length; di++) {
//     let dayKey = dayList[di];
//     Logger.log("=== Day=" + dayKey + " (index=" + di + ") 開始 ===");

//     // 曜日判定
//     let userDOW = calcUserDow(dayKey);

//     // (A) visits_needed>0 && nextEarliestDay <= di のクライアントを抽出
//     let preFilter = allClients.filter(cl => (cl.visits_needed > 0) && (cl.nextEarliestDay <= di));

//     // (B) 当日 userDOW に合ったスケジュールがあるかどうか
//     let remainClients = preFilter.filter(cl => {
//       let scheduleMap = parseVisitSummary_(cl.visitSummary);
//       return scheduleMap.hasOwnProperty(String(userDOW));
//     });
//     if (remainClients.length === 0) {
//       Logger.log("Day=" + dayKey + ": 対象クライアントなし => スキップ");
//       continue;
//     }

//     // ----------------------------------------------------
//     // 3-a) 「2人対応 (peopleCount=2)」だけを抽出して社員Dでルーティング
//     // ----------------------------------------------------
//     let subset2 = remainClients.filter(c => c.peopleCount === 2);
//     if (subset2.length > 0) {
//       Logger.log("Day=" + dayKey + ": 2人対応クライアントが " + subset2.length + "件 => 社員DでOR-Tools実行");

//       // デポ + subset2 の座標リスト
//       let latlngs2 = [{ lat: 35.7377805, lng: 139.7104871 }]; // 拠点(出発)
//       subset2.forEach(cl => {
//         let lat = 35.75, lng = 139.60;
//         try {
//           let [la, ln] = cl.address.split(",");
//           lat = parseFloat(la);
//           lng = parseFloat(ln);
//         } catch (e) { /* デフォルト値 */ }
//         latlngs2.push({ lat, lng });
//       });

//       // 距離行列
//       Logger.log("キャッシュシートで距離行列生成 => buildDistMatrixWithCache_ (2人対応)");
//       let distMat2 = buildDistMatrixWithCache_(latlngs2, API_KEY);
//       // バッファ上乗せ
//       applyTravelTimeBuffer_(distMat2);

//       // 社員D のみ
//       const employees2 = employeesFor2Person;  // <-- 上部で定義した配列を使用

//       const employeeTimeWindows2 = employees2.map(emp => {
//         const r = EMPLOYEE_TIME_RANGES[emp] || { start: 0, end: 900 };
//         return { start: r.start, end: r.end };
//       });

//       // [修正] ★スケジュールの取り扱いは元のロジック通り
//       subset2.forEach(cl => {
//         let scheduleMap = parseVisitSummary_(cl.visitSummary);
//         cl.scheduleWindows = scheduleMap;
//       });

//       // ペイロード
//       let payload2 = {
//         employees: employees2,
//         clients: subset2,
//         day_key: dayKey,
//         vehicle_costs: [10000],
//         max_vehicle_capacity: 6,
//         workday_length: 900,
//         employee_time_windows: employeeTimeWindows2,
//         dist_matrix: distMat2,
//         depot_lat: 35.7377805,
//         depot_lng: 139.7104871,
//         chunk_size: 25,
//         use_disjunction: true,
//         penalty_cost: 30000,
//         time_limit_seconds: 5,
//         first_solution_strategy: "AUTOMATIC",
//         local_search_metaheuristic: "AUTOMATIC",
//         priority_penalty_map: PRIORITY_PENALTY_MAP,
//         enable_lunch_break: true
//       };

//       // PythonにPOST
//       let opt2 = {
//         method: "post",
//         contentType: "application/json",
//         payload: JSON.stringify(payload2),
//         muteHttpExceptions: true
//       };
//       Logger.log("Docker上のPythonサーバへ POST => " + CF_URL + " (2人対応)");

//       try {
//         let resp2 = UrlFetchApp.fetch(CF_URL, opt2);
//         let code2 = resp2.getResponseCode();
//         Logger.log("HTTPレスポンス(2人対応)=" + code2);
//         if (code2 === 200) {
//           let jsn2 = JSON.parse(resp2.getContentText() || "{}");
//           Logger.log("status(2人対応)=" + jsn2.status);

//           // ★追加：エラー時のログ
//           if (jsn2.status === "error") {
//             Logger.log("=== Python側でエラー発生(2人対応) ===");
//             Logger.log("error_message: " + jsn2.error_message);
//             Logger.log("traceback: " + jsn2.traceback);
//           }
//           else if (jsn2.status === "ok") {
//             let solArr2 = jsn2.solution || [];
//             // visits_neededを減らす
//             solArr2.forEach(sol => {
//               let routeSteps = sol.route || [];
//               routeSteps.forEach(st => {
//                 if (st.location_name !== "出発拠点" && st.location_name !== "到着拠点") {
//                   let found = subset2.find(c => c.name === st.location_name);
//                   if (found) {
//                     found.visits_needed--;
//                     if (found.visits_needed > 0) {
//                       let orig = found.originalVisitsNeeded;
//                       let gap = VISIT_INTERVAL_4_OR_MORE; // デフォルト
//                       if (orig >= 4) {
//                         gap = VISIT_INTERVAL_4_OR_MORE;
//                       } else if (orig === 3) {
//                         gap = VISIT_INTERVAL_3;
//                       } else if (orig === 2) {
//                         gap = VISIT_INTERVAL_2;
//                       }
//                       found.nextEarliestDay = di + gap;
//                     }
//                   }
//                 }
//               });
//             });
//             addSolutionToFinalData(finalData, dayKey, solArr2);
//           } else {
//             Logger.log("Day=" + dayKey + " => status(2人対応)=" + jsn2.status);
//           }

//           if (jsn2.infeasible_clients) {
//             Logger.log("訪問不可能(2人対応)クライアント: " + JSON.stringify(jsn2.infeasible_clients));
//           }
//         } else {
//           Logger.log("Day=" + dayKey + " => HTTP(2人対応)=" + code2);
//           Logger.log(resp2.getContentText());
//         }
//       } catch (e) {
//         Logger.log("Day=" + dayKey + " => ex(2人対応)=" + e);
//       }

//       Utilities.sleep(500); // 過剰リクエスト防止
//     }

//     // ----------------------------------------------------
//     // 3-b) 「1人対応 (peopleCount=1)」をOR-Tools
//     //       ただし 2人対応があった日は社員Dを除外
//     //       (もし2人対応ゼロなら Dも参加可能)
//     // ----------------------------------------------------
//     let subset1 = remainClients.filter(c => c.peopleCount === 1);
//     if (subset1.length > 0) {
//       // subset2.length>0 なら社員Dは除外, なければDも含む
//       let employees1 = subset2.length > 0
//         ? employeesFor1PersonIf2PersonExists
//         : employeesFor1PersonIfNo2PersonExists;

//       Logger.log("Day=" + dayKey + ": 1人対応クライアントが " + subset1.length + "件 => " + employees1.join("/") + " でOR-Tools実行");

//       let latlngs1 = [{ lat: 35.7377805, lng: 139.7104871 }];
//       subset1.forEach(cl => {
//         let lat = 35.75, lng = 139.60;
//         try {
//           let [la, ln] = cl.address.split(",");
//           lat = parseFloat(la);
//           lng = parseFloat(ln);
//         } catch (e) { /* デフォルト値 */ }
//         latlngs1.push({ lat, lng });
//       });

//       let distMat1 = buildDistMatrixWithCache_(latlngs1, API_KEY);
//       applyTravelTimeBuffer_(distMat1);

//       const employeeTimeWindows1 = employees1.map(emp => {
//         const r = EMPLOYEE_TIME_RANGES[emp] || { start: 0, end: 900 };
//         return { start: r.start, end: r.end };
//       });

//       subset1.forEach(cl => {
//         let scheduleMap = parseVisitSummary_(cl.visitSummary);
//         cl.scheduleWindows = scheduleMap;
//       });

//       let payload1 = {
//         employees: employees1,
//         clients: subset1,
//         day_key: dayKey,
//         vehicle_costs: employees1.map((_, idx) => {
//           // ここはサンプルで適当にコストを付与(必要なければ固定でもOK)
//           if (idx === 0) return 0;
//           if (idx === 1) return 100;
//           if (idx === 2) return 1000;
//           if (idx === 3) return 10000;
//           return 10000;
//         }),
//         max_vehicle_capacity: 6,
//         workday_length: 900,
//         employee_time_windows: employeeTimeWindows1,
//         dist_matrix: distMat1,
//         depot_lat: 35.7377805,
//         depot_lng: 139.7104871,
//         chunk_size: 25,
//         use_disjunction: true,
//         penalty_cost: 30000,
//         time_limit_seconds: 5,
//         first_solution_strategy: "AUTOMATIC",
//         local_search_metaheuristic: "AUTOMATIC",
//         priority_penalty_map: PRIORITY_PENALTY_MAP,
//         enable_lunch_break: true
//       };

//       let opt1 = {
//         method: "post",
//         contentType: "application/json",
//         payload: JSON.stringify(payload1),
//         muteHttpExceptions: true
//       };
//       Logger.log("Docker上のPythonサーバへ POST => " + CF_URL + " (1人対応)");

//       try {
//         let resp1 = UrlFetchApp.fetch(CF_URL, opt1);
//         let code1 = resp1.getResponseCode();
//         Logger.log("HTTPレスポンス(1人対応)=" + code1);
//         if (code1 === 200) {
//           let jsn1 = JSON.parse(resp1.getContentText() || "{}");
//           Logger.log("status(1人対応)=" + jsn1.status);

//           // ★追加：エラー時のログ
//           if (jsn1.status === "error") {
//             Logger.log("=== Python側でエラー発生(1人対応) ===");
//             Logger.log("error_message: " + jsn1.error_message);
//             Logger.log("traceback: " + jsn1.traceback);
//           }
//           else if (jsn1.status === "ok") {
//             let solArr1 = jsn1.solution || [];
//             // visits_needed--
//             solArr1.forEach(sol => {
//               let routeSteps = sol.route || [];
//               routeSteps.forEach(st => {
//                 if (st.location_name !== "出発拠点" && st.location_name !== "到着拠点") {
//                   let found = subset1.find(c => c.name === st.location_name);
//                   if (found) {
//                     found.visits_needed--;
//                     if (found.visits_needed > 0) {
//                       let orig = found.originalVisitsNeeded;
//                       let gap = VISIT_INTERVAL_4_OR_MORE;
//                       if (orig >= 4) {
//                         gap = VISIT_INTERVAL_4_OR_MORE;
//                       } else if (orig === 3) {
//                         gap = VISIT_INTERVAL_3;
//                       } else if (orig === 2) {
//                         gap = VISIT_INTERVAL_2;
//                       }
//                       found.nextEarliestDay = di + gap;
//                     }
//                   }
//                 }
//               });
//             });
//             addSolutionToFinalData(finalData, dayKey, solArr1);

//           } else {
//             Logger.log("Day=" + dayKey + " => status(1人対応)=" + jsn1.status);
//           }

//           if (jsn1.infeasible_clients) {
//             Logger.log("訪問不可能(1人対応)クライアント: " + JSON.stringify(jsn1.infeasible_clients));
//           }
//         } else {
//           Logger.log("Day=" + dayKey + " => HTTP(1人対応)=" + code1);
//           Logger.log(resp1.getContentText());
//         }
//       } catch (e) {
//         Logger.log("Day=" + dayKey + " => ex(1人対応)=" + e);
//       }

//       Utilities.sleep(500);
//     }

//     Logger.log("=== Day=" + dayKey + " (index=" + di + ") 処理終了 ===");
//   } // end for dayList

//   // 4) 出力: ルート結果シート
//   Logger.log("Step4: ルート結果シートへ出力");
//   writeRouteSheet_(finalData, SSID);

//   // 5) 訪問しきれず (visits_needed>0) のクライアント
//   let notVisited = allClients.filter(cl => cl.visits_needed > 0);
//   if (notVisited.length > 0) {
//     Logger.log("=== 訪問不可能(または残り)クライアント一覧 ===");
//     notVisited.forEach(cl => {
//       Logger.log("ID=" + cl.id + ", name=" + cl.name + " => visits=" + cl.visits_needed);
//     });
//   }

//   // map 用
//   const routeJson = JSON.stringify(finalData);
//   PropertiesService.getScriptProperties().setProperty("LAST_ROUTE_DATA", routeJson);

//   Logger.log("Done => see route => " + ScriptApp.getService().getUrl());
//   Logger.log("=== callOrtoolsFunction 完了 ===");
// }


// /**
//  * 「訪問予定まとめコード」パース関数
//  * ex: "2+10:00-17:00/3+10:00-17:00/5+14:00-17:00/"
//  *   => {
//  *        "2": [240, 660], // 月曜(2) 10:00-17:00 => 6:00基準で (10:00→240,17:00→660)
//  *        "3": [240, 660],
//  *        "5": [480, 660]
//  *      }
//  */
// function parseVisitSummary_(summaryStr) {
//   let outMap = {};
//   if (!summaryStr) return outMap;
//   let arr = summaryStr.split("/");
//   arr.forEach(part => {
//     let p = part.trim();
//     if (!p) return;
//     let plusIdx = p.indexOf("+");
//     if (plusIdx < 0) return;
//     let dayStr = p.substring(0, plusIdx);
//     let restStr = p.substring(plusIdx + 1);
//     let dashIdx = restStr.indexOf("-");
//     if (dashIdx < 0) return;

//     let stStr = restStr.substring(0, dashIdx);
//     let enStr = restStr.substring(dashIdx + 1);
//     let dayNum = parseInt(dayStr, 10);

//     // 6:00基準に変更
//     let [stH, stM] = stStr.split(":");
//     let [enH, enM] = enStr.split(":");
//     let stMin = ((+stH || 0) * 60 + (+stM || 0)) - 6 * 60;
//     let enMin = ((+enH || 0) * 60 + (+enM || 0)) - 6 * 60;

//     if (stMin < 0) stMin = 0;
//     if (enMin > 900) enMin = 900;
//     if (stMin >= enMin) {
//       Logger.log("parseVisitSummary_ 警告: 不正な時間範囲 => " + p);
//       return;
//     }
//     outMap[dayNum.toString()] = [stMin, enMin];
//   });
//   return outMap;
// }


// /**
//  * 距離行列生成(キャッシュ利用)
//  *  - 近似計算(Haversine)で直線距離を算出し、東京近郊の時速(例:30km/h)から移動時間(分)を推定
//  */
// let gDistCacheMap = null;
// function buildDistMatrixWithCache_(latlngs, apiKey) {
//   Logger.log("buildDistMatrixWithCache_ => latlngs.length=" + latlngs.length);
//   if (!gDistCacheMap) {
//     gDistCacheMap = loadDistCacheToMap_();
//   }

//   const n = latlngs.length;
//   let mat = Array(n).fill(0).map(() => Array(n).fill(0));
//   let pendingRequests = [];

//   for (let i = 0; i < n; i++) {
//     for (let j = 0; j < n; j++) {
//       if (i === j) {
//         mat[i][j] = 0;
//       } else {
//         let fromObj = latlngs[i];
//         let toObj = latlngs[j];
//         let distMin = tryGetCacheDistance_(fromObj.lat, fromObj.lng, toObj.lat, toObj.lng);
//         if (distMin !== null) {
//           mat[i][j] = distMin;
//         } else {
//           // キャッシュになければHaversine近似を行い、シートに書き込む
//           pendingRequests.push({
//             fromIdx: i,
//             toIdx: j,
//             fromLat: +fromObj.lat.toFixed(5),
//             fromLng: +fromObj.lng.toFixed(5),
//             toLat: +toObj.lat.toFixed(5),
//             toLng: +toObj.lng.toFixed(5)
//           });
//         }
//       }
//     }
//   }

//   // 未キャッシュ分はHaversine近似計算し、キャッシュに入れる
//   if (pendingRequests.length > 0) {
//     Logger.log("Cache miss count=" + pendingRequests.length + " => Haversine近似計算を実行");

//     let chunkSize = 50;
//     let total = pendingRequests.length;
//     let ssId2 = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID_2");
//     let ss = SpreadsheetApp.openById(ssId2);
//     let sh = ss.getSheetByName("距離マトリックス");
//     if (!sh) {
//       sh = ss.insertSheet("距離マトリックス");
//       sh.appendRow(["fromLat", "fromLng", "toLat", "toLng", "distanceMin", "近似計算"]);
//     }

//     for (let start = 0; start < total; start += chunkSize) {
//       let end = Math.min(start + chunkSize, total);
//       let chunkIndex = Math.floor(start / chunkSize) + 1;
//       Logger.log("Haversine chunk #" + chunkIndex + " => " + (start + 1) + " - " + end + " / " + total);

//       let chunk = pendingRequests.slice(start, end);
//       let rowsToAppend = [];

//       chunk.forEach(rq => {
//         let dMin = computeHaversine_(rq.fromLat, rq.fromLng, rq.toLat, rq.toLng);
//         mat[rq.fromIdx][rq.toIdx] = dMin;
//         let key = makeDistKey_(rq.fromLat, rq.fromLng, rq.toLat, rq.toLng);
//         gDistCacheMap[key] = dMin;
//         rowsToAppend.push([
//           rq.fromLat, rq.fromLng,
//           rq.toLat, rq.toLng,
//           dMin, "ON"
//         ]);
//       });

//       if (rowsToAppend.length > 0) {
//         sh.getRange(sh.getLastRow() + 1, 1, rowsToAppend.length, 6).setValues(rowsToAppend);
//       }
//     }
//   }

//   return mat;
// }


// /**
//  * Haversine公式で直線距離(km)を算出し、
//  * 時速(例:30km/h)から走行時間(分)を概算する
//  */
// function computeHaversine_(lat1, lon1, lat2, lon2) {
//   const R = 6371;
//   function toRad(deg) { return deg * Math.PI / 180; }
//   const dLat = toRad(lat2 - lat1);
//   const dLon = toRad(lon2 - lon1);
//   const a = Math.sin(dLat / 2) ** 2
//     + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
//     * Math.sin(dLon / 2) ** 2;
//   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//   const distanceKm = R * c;
//   // 時速30km/h => 1kmあたり2分
//   let minutesPerKm = 2.0;
//   let travelMin = distanceKm * minutesPerKm;
//   return Math.round(travelMin);
// }


// /**
//  * キャッシュ読み込み
//  */
// function loadDistCacheToMap_() {
//   let mapObj = {};
//   let ssId2 = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID_2");
//   let ss = SpreadsheetApp.openById(ssId2);
//   let sh = ss.getSheetByName("距離マトリックス");
//   if (!sh) {
//     sh = ss.insertSheet("距離マトリックス");
//     sh.appendRow(["fromLat", "fromLng", "toLat", "toLng", "distanceMin", "近似計算"]);
//     gDistCacheMap = mapObj;
//     return gDistCacheMap;
//   }
//   let vals = sh.getDataRange().getValues();
//   if (vals.length < 2) {
//     gDistCacheMap = mapObj;
//     return gDistCacheMap;
//   }
//   for (let r = 1; r < vals.length; r++) {
//     let row = vals[r];
//     let key = makeDistKey_(+row[0], +row[1], +row[2], +row[3]);
//     mapObj[key] = +row[4];
//   }
//   Logger.log("loadDistCacheToMap_ => loaded count=" + (vals.length - 1));
//   gDistCacheMap = mapObj;
//   return gDistCacheMap;
// }


// /**
//  * キャッシュから取得
//  */
// function tryGetCacheDistance_(fromLat, fromLng, toLat, toLng) {
//   let key = makeDistKey_(fromLat, fromLng, toLat, toLng);
//   let val = gDistCacheMap[key];
//   if (val === undefined) return null;
//   return val;
// }


// /**
//  * キー生成
//  */
// function makeDistKey_(fLa, fLo, tLa, tLo) {
//   return [fLa.toFixed(5), fLo.toFixed(5), tLa.toFixed(5), tLo.toFixed(5)].join(",");
// }


// /**
//  * ルート結果をシートに出力
//  */
// function writeRouteSheet_(daysArr, ssId) {
//   Logger.log("writeRouteSheet_ => SSID=" + ssId);
//   let ss = SpreadsheetApp.openById(ssId);
//   let shName = "ルート結果";
//   let sh = ss.getSheetByName(shName) || ss.insertSheet(shName);
//   sh.clear();
//   sh.appendRow([
//     "社員", "日付", "訪問順", "場所", "到着時刻", "出発時刻",
//     "移動(分)", "滞在(分)", "lat", "lng"
//   ]);

//   let rows = [];
//   daysArr.forEach(dObj => {
//     let dy = dObj.day_key;
//     (dObj.solution || []).forEach(sol => {
//       let emp = sol.employee;
//       let route = sol.route || [];
//       route.forEach((st, ix) => {
//         let arrMin = parseHHMM_(st.time || "06:00");
//         let trav = st.travel_minutes || 0;
//         let sty = st.stay_min || 0;
//         let dep = arrMin + sty;

//         let lat = st.lat;
//         let lng = st.lng;

//         // 昼休憩などの仮ノードにはデフォルト座標
//         if (typeof lat === "undefined") lat = 0;
//         if (typeof lng === "undefined") lng = 0;

//         rows.push([
//           emp,
//           dy,
//           ix,
//           (st.location_name || ""),
//           (st.time || ""),
//           minToHHMM_(dep),
//           trav,
//           sty,
//           lat,
//           lng
//         ]);
//       });
//     });
//   });

//   if (rows.length > 0) {
//     sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
//   }

//   Logger.log("writeRouteSheet_ => rows=" + rows.length);
// }



// /**
//  * "到着時刻"文字列 → 6:00基準の分
//  */
// function parseHHMM_(t) {
//   let [hh, mm] = (t || "06:00").split(":");
//   let H = parseInt(hh, 10) || 6;
//   let M = parseInt(mm, 10) || 0;
//   return (H * 60 + M) - (6 * 60);
// }


// /**
//  * 6:00基準の「分」 → "HH:MM"
//  */
// function minToHHMM_(val) {
//   let base = (6 * 60) + val;
//   let hh = Math.floor(base / 60);
//   let mm = base % 60;
//   return ("0" + hh).slice(-2) + ":" + ("0" + mm).slice(-2);
// }


// /**
//  * doGet => map (描画用HTMLを返す)
//  */
// function doGet() {
//   Logger.log("doGet => map");
//   const apiKey = PropertiesService.getScriptProperties().getProperty("apiKey") || "";
//   const dataStr = PropertiesService.getScriptProperties().getProperty("LAST_ROUTE_DATA") || "[]";
//   let tpl = HtmlService.createTemplateFromFile("map");
//   tpl.apiKey = apiKey;
//   tpl.routeDataJson = dataStr;
//   return tpl.evaluate().setTitle("VRP Map");
// }


// /**
//  * A) 客先情報メイン読み込み
//  *    - シート「訪問予定調整」
//  *    - ID契約 / 契約名 / 訪問予定まとめコード / 座標 / 契約状況 / 訪問回数 / ALL担当会社 / 滞在時間 / (★対応人数) / (★優先順位)
//  *    - 条件:
//  *        * 空欄でない
//  *        * 契約状況 in ["継続中","終了予定"]
//  *        * ALL担当会社に"東京アクアガーデン"含む
//  */
// function readRealClientData_(ssId2, sheetName) {
//   Logger.log("=== readRealClientData_ (from '訪問予定調整') 開始 ===");
//   const ss2 = SpreadsheetApp.openById(ssId2);
//   const sh2 = ss2.getSheetByName(sheetName);
//   if (!sh2) {
//     Logger.log("Sheet not found => " + sheetName);
//     return [];
//   }

//   const vals2 = sh2.getDataRange().getValues();
//   if (vals2.length < 2) {
//     Logger.log("No data => length=" + vals2.length + ", sheet=" + sheetName);
//     return [];
//   }
//   const hdr2 = vals2[0];
//   Logger.log("訪問予定調整 Header => " + JSON.stringify(hdr2));

//   const idx_idContract = hdr2.indexOf("ID契約");
//   const idx_name = hdr2.indexOf("契約名");
//   const idx_summary = hdr2.indexOf("訪問予定まとめコード");
//   const idx_coord = hdr2.indexOf("座標");
//   const idx_status = hdr2.indexOf("契約状況");
//   const idx_visits = hdr2.indexOf("訪問回数");
//   const idx_allCompany = hdr2.indexOf("ALL担当会社");
//   const idx_stayTime = hdr2.indexOf("滞在時間");
//   // ★追加
//   const idx_priority = hdr2.indexOf("優先順位");
//   const idx_peopleCount = hdr2.indexOf("対応人数");
//   const idx_excludeSystem = hdr2.indexOf("システム除外");

//   if (
//     idx_idContract < 0 ||
//     idx_name < 0 ||
//     idx_summary < 0 ||
//     idx_coord < 0 ||
//     idx_status < 0 ||
//     idx_visits < 0 ||
//     idx_allCompany < 0 ||
//     idx_stayTime < 0
//   ) {
//     Logger.log("必要な列が不足 => ID契約/契約名/訪問予定まとめコード/座標/契約状況/訪問回数/ALL担当会社/滞在時間");
//     return [];
//   }

//   let outArr = [];
//   for (let r = 1; r < vals2.length; r++) {
//     let row = vals2[r];
//     let cid = String(row[idx_idContract] || "").trim();
//     let nm = String(row[idx_name] || "").trim();
//     let vsum = String(row[idx_summary] || "").trim();
//     let coord = String(row[idx_coord] || "").trim();
//     let stat = String(row[idx_status] || "").trim();
//     let vcountRaw = String(row[idx_visits] || "").trim();
//     let allComp = String(row[idx_allCompany] || "").trim();
//     let stayRaw = row[idx_stayTime];
//     let stayVal = parseInt(stayRaw, 10) || 30;

//     let priorityVal = 5;
//     if (idx_priority >= 0) {
//       let pRaw = String(row[idx_priority] || "").trim();
//       if (pRaw !== "") {
//         priorityVal = parseInt(pRaw, 10) || 5;
//       }
//     }

//     let peopleCount = 1;
//     if (idx_peopleCount >= 0) {
//       let pcRaw = String(row[idx_peopleCount] || "").trim();
//       if (pcRaw !== "") {
//         peopleCount = parseInt(pcRaw, 10) || 1;
//       }
//     }
//     if (idx_excludeSystem >= 0) {
//       let excludeVal = String(row[idx_excludeSystem] || "").trim();
//       if (excludeVal === "ON") {
//         continue;
//       }
//     }
//     if (!cid || !nm || !vsum || !coord || !stat || !vcountRaw || !allComp) {
//       continue;
//     }
//     if (stat !== "継続中" && stat !== "終了予定") {
//       continue;
//     }
//     if (allComp.indexOf("東京アクアガーデン") < 0) {
//       continue;
//     }

//     let vcount = parseInt(vcountRaw, 10) || 1;
//     outArr.push({
//       id: cid,
//       name: nm,
//       address: coord,
//       status: stat,
//       visitSummary: vsum,
//       visits_needed: vcount,
//       originalVisitsNeeded: vcount,
//       nextEarliestDay: 0,
//       stay_min: stayVal,
//       priority: priorityVal,
//       peopleCount: peopleCount
//     });
//   }

//   Logger.log("readRealClientData_ => length=" + outArr.length);
//   if (outArr.length > 0) {
//     Logger.log("先頭クライアント例: " + JSON.stringify(outArr[0]));
//   }
//   return outArr;
// }


// /** 配列シャッフル */
// function shuffleArray(arr) {
//   for (let i = arr.length - 1; i > 0; i--) {
//     let j = Math.floor(Math.random() * (i + 1));
//     [arr[i], arr[j]] = [arr[j], arr[i]];
//   }
// }


// /**
//  * 旧: 2025-04-01～04-30 (土日除く) の日付一覧
//  * 今: TARGET_YEAR / TARGET_MONTH の1日～末日まで、土日と「当社の休日」を除く
//  */
// function makeDateList_2025_04_01_04_30_skipWeekend() {
//   Logger.log("makeDateList_2025_04_01_04_30_skipWeekend 開始");

//   // 会社の休日を取得
//   const holidaySet = readCompanyHolidayDays_(TARGET_YEAR, TARGET_MONTH);

//   let lastDay = new Date(TARGET_YEAR, TARGET_MONTH, 0).getDate();
//   let out = [];
//   for (let day = 1; day <= lastDay; day++) {
//     let d = new Date(TARGET_YEAR, TARGET_MONTH - 1, day);
//     let w = d.getDay(); // 0=日, 6=土
//     if (w === 0 || w === 6) {
//       continue;
//     }
//     if (holidaySet.has(day)) {
//       continue;
//     }
//     let y = d.getFullYear();
//     let m = ("0" + (d.getMonth() + 1)).slice(-2);
//     let dd = ("0" + d.getDate()).slice(-2);
//     out.push(`${y}-${m}-${dd}`);
//   }
//   Logger.log("makeDateList_2025_04_01_04_30_skipWeekend 完了 => " + JSON.stringify(out));
//   return out;
// }


// /**
//  * 当社の休日シート(SPREADSHEET_ID_4) から、対象年月に合致する日だけセットで返す
//  */
// function readCompanyHolidayDays_(year, month) {
//   Logger.log("readCompanyHolidayDays_ => year=" + year + ", month=" + month);
//   const holidaySet = new Set();

//   const props = PropertiesService.getScriptProperties();
//   const ssId4 = props.getProperty("SPREADSHEET_ID_4");
//   if (!ssId4) {
//     Logger.log("SPREADSHEET_ID_4 が未設定です。");
//     return holidaySet;
//   }

//   let ss = SpreadsheetApp.openById(ssId4);
//   let sh = ss.getSheetByName("当社の休日");
//   if (!sh) {
//     Logger.log("シート『当社の休日』が見つかりません");
//     return holidaySet;
//   }

//   let vals = sh.getDataRange().getValues();
//   if (vals.length < 2) {
//     Logger.log("当社の休日シート: データがありません");
//     return holidaySet;
//   }

//   let hdr = vals[0];
//   let idx_holidayDate = hdr.indexOf("休日日付");
//   if (idx_holidayDate < 0) {
//     Logger.log("当社の休日シート: 『休日日付』列が見つかりません");
//     return holidaySet;
//   }

//   for (let i = 1; i < vals.length; i++) {
//     let row = vals[i];
//     let rawDate = String(row[idx_holidayDate] || "").trim();
//     if (!rawDate) continue;
//     let dt = new Date(rawDate);
//     if (isNaN(dt.getTime())) {
//       continue;
//     }
//     if (dt.getFullYear() === year && dt.getMonth() === (month - 1)) {
//       holidaySet.add(dt.getDate());
//     }
//   }

//   Logger.log("当社の休日: 取得件数=" + holidaySet.size + " => " + JSON.stringify(Array.from(holidaySet)));
//   return holidaySet;
// }


// /**
//  * 曜日をユーザ定義の数字に変換 (1=日,2=月,...7=土)
//  */
// function calcUserDow(dayKey) {
//   let dt = new Date(dayKey + "T00:00:00");
//   let w = dt.getDay(); // 0=日, 1=月,...
//   const map_dow = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
//   return map_dow[w];
// }


// /**
//  * distMat の各要素にバッファを上乗せ
//  */
// function applyTravelTimeBuffer_(distMat) {
//   let n = distMat.length;
//   for (let i = 0; i < n; i++) {
//     for (let j = 0; j < n; j++) {
//       if (i === j) continue;
//       let d = distMat[i][j];
//       if (d < 30) {
//         distMat[i][j] = d + BUFFER_UNDER_30;
//       } else if (d < 60) {
//         distMat[i][j] = d + BUFFER_30_59;
//       } else {
//         distMat[i][j] = d + BUFFER_60_OVER;
//       }
//     }
//   }
// }